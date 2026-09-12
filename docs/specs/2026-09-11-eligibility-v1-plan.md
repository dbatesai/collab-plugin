# Eligibility v1 — implementation plan (collab-plugin 1.2.0)

**Owner:** Keel · **Branch:** `feat/eligibility-v1` off `next` @ `3b97ac6` (suite 347/347 green) · **Reviewers:** Hale (diff + synthetic replay), Agy (spec conformance) · **Orchestration:** Muse · **Approval:** David, 2026-09-11.

**What this implements:** the reduced spec v2 as re-signed by Keel, Hale, and Agy; the wait-cycle visibility rules with Hale's lifecycle correction; the reread convention documented with its race limitation. Nothing else. The stale-context follow-up, participant identity, transport defaults, never-closed sessions, and wall-clock extension are out of scope by decision.

**Method:** tests first. Every new test is run red against `3b97ac6` (a worktree at that commit) before the code that makes it green exists; both runs are recorded in `docs/specs/2026-09-11-eligibility-v1-receipts.md`. Every check that could pass vacuously carries a mutation control.

## 1. The one rule that decides everything: interpret by shape, guarantee at write

| Field | Absent | Present, valid | Present, invalid |
|---|---|---|---|
| kickoff `ratified_completion_measures` | **legacy** session: nothing in this plan fires; ledger reads exactly as at `3b97ac6` | contract session | validation errors; second distinct join refused with `contract-invalid` |
| verdict `measures` (author is a named reviewer) | **legacy-shaped** credit: discharges every measure naming the author, labeled `scope: 'legacy'`, scoped to the active propose-close exactly as today | scoped credit, `scope: 'scoped'`, window = declaration → terminal close | event refused whole; credits nothing |
| verdict `measures` (author owes nothing) | whole-synthesis ratification, as today | warning `verdict-measures-ignored`; field ignored | same warning |

The **writer** (`collab-kickoff.mjs`, and `appendEvent` as the chokepoint every emitter uses) refuses to *create* an undeclared non-solo kickoff or an unscoped verdict from a named reviewer. The **reader** never infers which version wrote a ledger. Guarantee sentence, verbatim in `SKILL.md`: *"The plugin guarantees what its writer emits — every kickoff it creates for a non-solo session declares valid measures, and every verdict it writes from a named reviewer is scoped. It does not guarantee that every ledger the reader accepts contains scoped agreement. A `scope: 'legacy'` label on a credit records how that credit was interpreted; it does not prove the event's age, its writer, or explicit measure-level assent."*

**Replay preservation, stated precisely:** legacy-shaped verdicts keep today's post-propose-close scoping so a 1.1.0 ledger with measures and bare verdicts computes the identical outcome and identical unmet list; the only observable difference is the `scope` label in the new receipt fields, which the old reader never emitted.

## 2. Work packages, in TDD order

### WP1 — Kickoff writer gate (`collab-kickoff.mjs`, ~25 lines)
- New repeatable flag `--measure "<id>|<description>|<triplet>"`; `--required-review <triplet>` kept, still generating `independent-review-<slug>` + a real description.
- `buildKickoffPayload` refuses when `capabilities_wanted` is non-empty and measures are absent/empty (`completion-measures-required`), when any description is empty or matches `/^\(measure inferred/` (`completion-measure-placeholder: <id>`), or when ids duplicate or `id`/`requires_review_from` are missing (`completion-measure-invalid: <id>`). Solo kickoffs (empty `capabilities_wanted`) are exempt.
- Tests (`tests/test-collab-kickoff.mjs`, additions): refuse-absent-non-solo; allow-solo-absent; refuse-placeholder; refuse-duplicate-id; accept-valid-measure-flag; `--measure` parse errors. Mutation control: each refusal test also asserts the same payload *with the defect removed* is accepted.

### WP2 — Validator (`collab-validate.mjs`, ~40 lines)
- Kickoff measures: nonempty non-placeholder `description` required (`completion-measure-placeholder`), duplicate ids (`completion-measure-invalid`).
- Join `owes_review`: unknown id → `measure-unknown: <id>`; id naming another reviewer → `verdict-reviewer-mismatch`-style error `owes-review-not-owed: <id>` (error); named reviewer under-acknowledging → warning `review-ack-mismatch: <participant>`.
- Verdict `measures` present: unknown id → `measure-unknown`; id naming another reviewer → `verdict-reviewer-mismatch: <reviewer> <id>`; empty array from a named reviewer → `verdict-unscoped`; non-owed author → warning `verdict-measures-ignored`; second verdict by the same author on a measure already judged by that author earlier in ledger order → `verdict-duplicate: <reviewer> <id>` (whole event refused, so `[A, B]` after `[A]` credits neither).
- Tests (`tests/test-collab-validate.mjs`, additions): one test per string; a legacy July-31-shaped ledger and a measured-with-bare-verdicts ledger both validate with zero *new* errors (control: the same ledgers with a scoped verdict carrying an unknown id do produce exactly one).

### WP3 — Read-time semantics (`collab-event-helpers.mjs`, ~90 lines)
- `declaredMeasures(events)`; `measureVerdicts(events, nowTs)` → per measure `{ ratified: [{by, event_id, scope}], objected: [{by, reason, event_id, scope}] }` applying the shape table; `unmetRequiredReviews` re-implemented on top of it (per `(measure, reviewer)`), legacy-shaped verdicts scoped post-propose, scoped verdicts scoped declaration→close, close event as hard cutoff.
- `computeCloseOutcome(events, nowTs, { route })` — the single calculation both routes call: any objected → `failed-safely`; else any ratified → `complete-to-authority-boundary`; else `failed-safely`; proposer route only: every measure ratified, none objected, synthesis converged → `converged`. Returns the receipt: `ratified_measures`, `objected_measures`, `unmet_ratified_measures`, `missing_reviews_from`, `ratified_by`, `note`.
- `effectiveDeadline(turn, events)` = strict-ISO `next_update_by` else `turn.ts + tick_interval`; `effectiveOnTimeout(turn)` = declared else `proceed-alone`. `evaluateObligations` and the tick's chase loop consume these; computed, never written back.
- `openRequests(events, participant)` — turns by others whose `waiting_on` names the participant; state `requested` until a turn by the participant references it with `signals` containing `accepted` (→ `accepted`), `declined` (closed), or `delivered` (closed), or a scoped verdict on the requested measure (closed), or the requester's `timeout-action` for that deadline (`lapsed`, closed). Any other referencing turn changes nothing.
- `waitCycles(events)` — pairs of open requests A→B and B→A; keyed by the two request ids so a pair is reported once while unchanged; acceptance does not hide a pair.
- Tests: `tests/test-collab-eligibility.mjs` (cases 1–8 with sub-cases, §3), `tests/test-collab-default-deadline.mjs`, `tests/test-collab-wait-cycle.mjs`, `tests/test-collab-replay-legacy.mjs` (fixtures: the July 31 ledger copied verbatim; a synthetic 1.1.0 measured ledger with bare verdicts — expected outcome/unmet computed at `3b97ac6` and stored as JSON, asserted equal under the new reader).

### WP4 — Tick (`collab-tick.mjs`, ~45 lines)
- Stall net: contract session → `computeCloseOutcome({route:'stall'})`; legacy → `aborted-stall` unchanged. Authority-boundary route → same function `{route:'proposer'}`. `emit-close` unchanged for legacy; for contract sessions it is reached only when the function returns `converged`.
- Second distinct join into a contract session whose declaration is invalid → `{ action: 'contract-invalid', errors, repair: 'close this session failed-safely and kick off again with valid --measure flags' }`; same participant re-joining does not trigger it; absent measures never trigger it.
- Chase loop uses `effectiveDeadline`/`effectiveOnTimeout`; `timeout-action` executes `proceed-alone` by default (moves no ownership).
- Tick result carries `open_requests` (for the ticking participant) and `wait_cycles`; a new pair emits one system turn `signals: ['wait-cycle', A, B]`, deduplicated by pair key.
- Tests: in the files above, plus `tests/test-collab-tick.mjs` additions for `contract-invalid` (refuse; same-participant no-trigger; absent-measures no-trigger).

### WP5 — Render and status (`collab-render.mjs`, `collab-status.mjs`, ~40 lines)
- `STATUS.md` gains **Measures** (id, reviewer, state: ratified/objected/unmet, scope) and **Waiting** (requester → recipient, since, deadline, fallback, state) sections; the close section prints the receipt fields. `collab-status` one-liner shows open-request count.
- Tests: `tests/test-collab-render.mjs` additions — table rows present/absent for each lifecycle state; snapshot control that a legacy ledger renders without the new sections' contract rows.

### WP6 — `appendEvent` writer gate (`collab-event-helpers.mjs`, ~20 lines)
- For `type` in `ratify|object`, if the ledger's declared measures name the author and the payload lacks a non-empty `measures` array → throw `verdict-unscoped`. For `type: 'kickoff'` with non-empty `capabilities_wanted` and no valid measures → throw `completion-measures-required` (belt to WP1's braces). Refusal happens before any file is written. Reads the ledger only for those three types.
- Tests (`tests/test-collab-append-noclobber.mjs` additions): refused write leaves no file; non-owed author unscoped verdict is written; legacy session (no measures) unscoped verdict is written.

### WP7 — Docs and version (~40 lines)
- `SKILL.md`: `--measure` and phase-measure guidance (Agy's lesson), verdict scoping, lifecycle signals, the Waiting table, the reread convention with its race limitation, the guarantee sentence verbatim, `verdict-duplicate` as an explicit limitation.
- `README.md` outcome line and event fields; `CHANGELOG.md` 1.2.0; version bump on every surface via the tree-enumerating bump (minor: a kickoff shape that validates today can now be refused by the writer).

### WP8 — Receipts
- Full suite on the branch; each new test file run against a `3b97ac6` worktree showing the expected failures; both logs in the receipts file with the SHAs. Candidate SHA posted to `~/files` for Hale and Agy.

## 3. Acceptance cases → tests (the bar Hale and Agy set)

Setup for `test-collab-eligibility.mjs`: kickoff declares `M-A`, `M-B` (reviewer R1), `M-C` (reviewer R2); proposer P; non-owed Q; 5-minute cadence; timestamps synthetic.

1. **Never joins** — R2 never joins; after propose-close and window, `M-C` unmet, `missing_reviews_from: [R2]`, R2 not in `ratified_by`.
2. **Joins then silent** — R1 joins with `owes_review: [M-A, M-B]`, never posts; both unmet; close `failed-safely` unless another measure is explicitly ratified; chases postpone nothing.
3. **Objection** — R1 ratifies `[M-A]`, R2 objects `[M-C]` → `failed-safely`, `M-C` objected with reason, `M-A` still listed ratified, objection blocks authority boundary.
4. **Unknown id** — join `owes_review: [M-A, M-Z]` refused; verdict `[M-A, M-Z]` refused; declared list byte-identical; no partial credit.
5. **No proposer before stall** — three sub-cases: `[M-A]` ratified then stall → `complete-to-authority-boundary` with M-A ratified, M-B/M-C unmet; no verdicts then stall → `failed-safely`, all unmet, note names the stall route; legacy no-measure ledger then stall → `aborted-stall`.
6. **Late reply after close** — a scoped `ratify` appended after the close: appends, validates, close bytes unchanged, no second close, receipt unchanged.
7. **Scoped verdict** — `[M-A]` credits A only, B unmet; Q's bare ratify counts in `ratified_by` as whole-synthesis only.
8. **Unscoped verdict** — `appendEvent` refuses a bare ratify from R1 (writer); a hand-placed bare ratify from R1 in the ledger reads as legacy credit labeled `scope: 'legacy'` (reader), and the measured-1.1.0 replay fixture computes identically to `3b97ac6`.

Plus: ratify-A / object-B / propose-close sequence (B still blocks); `verdict-duplicate` (`[A]` then `[A, B]` refused, neither credited; ratify then object on the same measure refused); same-participant repeated join never triggers `contract-invalid`; absent measures never trigger it; class-18 assertion that the close's `ratified_measures` is empty and `unmet_ratified_measures` names `DG1-independent-review` by id.

`test-collab-default-deadline.mjs`: a turn without `next_update_by` is chased one cadence plus grace later; a chase does not reset it; the participant's own event does; three chases then `proceed-alone` executes as a `timeout-action` and `owner`/`waiting_on` fields on the ledger are unchanged; explicit deadlines and `on_timeout` are untouched.

`test-collab-wait-cycle.mjs`: request visible as `requested`; B's clarifying question leaves it `requested`; B's `accepted` turn → `accepted`, still visible; a progress note leaves it open; `declined` closes; `delivered` closes; a scoped verdict on the requested measure closes; the requester's timeout fallback → `lapsed`, measure still unmet; A→B and B→A → one `wait-cycle` turn, not two, and none on the next unchanged tick; both accepted and still mutually waiting → still a pair.

## 4. What I will say when I deviate

If a test forces a design change not covered by the signed spec, I stop, post the case to `~/files`, and wait for Hale/Agy before choosing. If an advisor objects and I overrule, the overrule is written down with the reason so David can see it.
