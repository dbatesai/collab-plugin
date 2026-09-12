# Eligibility v1 — receipts

Branch `feat/eligibility-v1`, off `next` @ `3b97ac6` (v1.1.0, suite 347/347). Plan: `2026-09-11-eligibility-v1-plan.md`. Every work package was tests-first: each test file was run against a detached worktree at `3b97ac6` before the production change, and the whole suite on the branch after it.

## Commits

| WP | Commit | What |
|---|---|---|
| plan | `d9cdfdf` | the implementation plan |
| 1 | `a25fe77` | kickoff writer gate: `--measure`, `validateMeasures`, `parseMeasureFlag`, non-solo refusal |
| 2 | `aeb649e` | validator rules: measure checks, `owes_review` binding, scoped-verdict checks, `verdict-duplicate` |
| 3 | `f5e0e04` | read-time semantics: `declaredMeasures`, `measureVerdicts`, `computeCloseOutcome`, `effectiveDeadline`, `effectiveOnTimeout`, `openRequests`, `waitCycles`; `unmetRequiredReviews` re-keyed by measure; obligation defaults |
| 4–6 | `d19da5f` | tick (stall/proposer outcome, `contract-invalid`, chase defaults + timeout execution, `open_requests`/`wait_cycles`, wait-cycle system turn), render (Measures, Waiting, close receipt), status one-liner, `appendEvent` gate; `validateMeasures` moved into helpers |
| 7 | `da9ad13` | SKILL.md, README, CHANGELOG (under `[Unreleased]`) |
| 8 | this commit | replay fixtures + test, this file |

Version surfaces stay at 1.1.0. `/cut-release` stamped 1.1.0 across all five surfaces in one commit (`389f208`); it does the same for 1.2.0.

## Red at `3b97ac6`, green on the branch

Each file run alone with `node --test --test-reporter=tap`. "Red" is the file copied unchanged into the `3b97ac6` worktree; "green" is the same file on the branch.

| File | Red at `3b97ac6` | Green on branch | Notes |
|---|---|---|---|
| `test-collab-eligibility.mjs` (new) | 0 / 15 | 15 / 15 | acceptance cases 1, 2, 3, 5a–c, 7; shape rules; sequence; synthetic 1.1.0 replay |
| `test-collab-eligibility-validate.mjs` (new) | 3 / 15 | 15 / 15 | the 3 that pass at baseline are legacy-tolerance controls — the old validator never errored on those shapes either |
| `test-collab-eligibility-tick.mjs` (new) | 4 / 12 | 12 / 12 | 4 baseline passes are controls: legacy stall still `aborted-stall`; converged when everything is ratified; contract-invalid not triggered by one joiner / absent measures |
| `test-collab-default-deadline.mjs` (new) | 2 / 7 | 7 / 7 | 2 controls: outer bounds unchanged; a chase never creates a chaser obligation |
| `test-collab-wait-cycle.mjs` (new) | 0 / 6 | 6 / 6 | |
| `test-collab-replay-legacy.mjs` (new) | 1 / 4 | 4 / 4 | the 1 that passes at baseline is the preservation test itself: the July 31 ledger closes the same way under both readers |
| `test-collab-kickoff.mjs` (+6) | 16 / 21 | 21 / 21 | one of the six new tests is the solo-kickoff control |
| `test-collab-render.mjs` (+5) | 13 / 17 | 17 / 17 | the legacy-ledger-has-no-Measures-section control passes at baseline |
| `test-collab-append-noclobber.mjs` (+4) | 6 / 8 | 8 / 8 | the two that pass at baseline are the "is written" controls (non-owed author; legacy session) |
| `test-collab-obligations.mjs` (12 narrowed, +1) | 8 / 9 | 9 / 9 | see "spec-driven test changes" |
| `test-collab-chase.mjs` (1 rewritten) | 6 / 7 | 7 / 7 | see "spec-driven test changes" |

Full suite on the branch: **422 / 422** (`node --test tests/test-*.mjs`). Baseline `3b97ac6`: 347 / 347.

## Spec-driven changes to existing tests

Two existing tests encoded behavior the signed spec replaces. Both were changed to the spec, not to the code, and both are called out here so a reviewer can disagree.

- `test-collab-obligations.mjs` test 12, "a waiting_on with no on_timeout is rejected": under the spec an absent `on_timeout` defaults to `proceed-alone`. The test now asserts the narrower rule that survived — a *declared* `on_timeout` outside the vocabulary is still refused as an unbounded wait — and a new test asserts the default. (The July 31 ledger shows why: at `3b97ac6` one of Hale's turns was flagged `invalid` for a deadline without `on_timeout`, and nothing acted on that flag.)
- `test-collab-chase.mjs`, "no chase when no next_update_by commitment": under the spec a turn with no deadline is due one cadence after its timestamp. The rewritten test asserts no chase at 20 minutes and one chase at 40 (default 30-minute cadence, 5-minute grace).

## Fixtures

`tests/fixtures/2026-07-31-legacy-stall/` is the July 31 ledger (`files/collabs/2026-07-31-agy-keel-and-hale-agree-on-shared-spec-for-teamgoa`), structure-preserving rather than verbatim, because this repository is public: the machine name in every triplet is replaced by `host`, and each prose body is cut to its heading line. Every field the reader consults — ids, timestamps, types, authors, references, payload shapes — is unchanged. `expected-3b97ac6.json` beside it was produced by running the `3b97ac6` reader on the fixture: `net_at_close: 'stall'`, `route_at_close: 'safety-net:stall'`, `unmet: []`, `ratification: null`, no obligations due, one `invalid` (the missing `on_timeout`).

`tests/fixtures/legacy-measured-expected-3b97ac6.json` is the `3b97ac6` reader's view of the synthetic 1.1.0 measured ledger (measures declared, bare verdicts after the propose-close): `unmet: []`, R1 explicitly ratified, R2 objected, `converged: false`, no validation errors. The branch computes the same, and additionally labels each credit `scope: 'legacy'`.

## Decisions taken during implementation, for review

- **`contract-invalid` is checked before the safety nets.** A session whose declaration would not pass the writer never gets a computed outcome from the stall net; the tick returns the repair instruction instead. The consequence is that such a session does not auto-close — the repair (close `failed-safely` by hand, re-kick-off) is the only exit. The alternative, letting the stall net compute an outcome from an invalid contract, seemed worse.
- **Only the stall net uses the shared outcome calculation.** The plan named the stall net and the proposer route. The wall-clock net still closes `aborted-budget` and objection-deadlock `aborted-objection` for every session, measured or not. Wall-clock on a measured session is a candidate for the same treatment; it is not in this release.
- **A measure judged before the propose-close counts; a legacy verdict before it does not.** Scoped verdicts run from declaration to close. Bare verdicts keep the 1.1.0 window (after the active propose-close) because that is what "replay identical" requires.
- **`getRatificationStatus` is unchanged.** Silence-as-ratification, its narrowing for named reviewers, and `converged` mean exactly what they meant. `computeCloseOutcome` consults it for `ratified_by` and for the `converged` gate.
- **The wait-cycle system turn** carries `waiting_on: null`, `signals: ['wait-cycle', <a>, <b>]`, and `wait_cycle: { key, participants, requests }`; `isSystemTurn` treats it like a chase (commits nobody, requests nothing, is not progress).
- **The receipt's `ratified_by`** is `explicitRatified` from the ratification status, as the 1.1.0 authority-boundary close already did; silence never appears there.

## Round 3 — Hale's plan-checkpoint findings (`hale-to-muse-round-3-plan-review-2026-09-11-0f0c2ae.md`)

Hale reviewed the snapshot at `f5e0e04` and found two material defects. Both were real; both are fixed in the commit after `7ce77ef`, tests first.

**R3-H1 — the fallback was gated on the chase ladder.** The settled text is *"the first authorized check at or after the deadline takes the declared fallback."* The code (inherited from the 1.1.0 obligation scanner) executed the fallback only after three chases, so a participant an hour offline still only got a chase. Now: `evaluateObligations` returns the fallback entry at the first check where `now ≥ deadline`, once per deadline (a `timeout-action` with that `for_deadline` settles it), for *every* author's latest substantive turn — the ticking participant's own included, because an absent counterpart is the case the bound exists for. Chases are reminders: they start after the 5-minute grace, stop at the flood limit, are counted per participant, and no longer gate anything. The tick's chase loop was replaced by the scanner's output (one source of truth) plus the existing 60-minute flood window. Tests: helper (`test-collab-obligations.mjs` 12 ×3 rewritten, `test-collab-default-deadline.mjs` ×2 new/rewritten: just-before-deadline, at-deadline, an hour late, retry/no-duplicate) and route (`test-collab-eligibility-tick.mjs` `tick/deadline` ×3: default, explicit-an-hour-late, own bound).

**R3-M1 — a refused verdict delivered a request.** `openRequests` marked a request delivered on any scoped verdict referencing it. Now delivery reuses accepted-credit semantics exactly: a verdict discharges a request only if `measureVerdicts` credited that event, and — when the request names what it is about (`measures` on the turn, the explicit request-to-measure link) — only if the credited ids intersect it. Tests: unknown id, wrong reviewer, duplicate overlap, bare verdict, no verdict, valid-but-unrelated, valid matching, request with no named measure (`test-collab-wait-cycle.mjs` `disposition` ×2); and through the tick (`test-collab-eligibility-tick.mjs` `tick/requests: a refused verdict…`). Render and status call the same helper.

**Acceptance-map additions (Hale item 3):** malformed measure field types refused before any file (`gate: malformed measure field types…`); same-id retry vs conflicting payload → existing classes 5 and 8; interruption around close then retry, conflicting close under the same id, a second close under a fresh id (`recovery: a close re-appended…` — the first close is the terminal record every reader reports; closes are distributed by design, so the second is recorded, not refused); two writers overlapping a verdict (`gate: a second verdict on a measure the ledger already shows judged…` — refused at write when the ledger already shows the judgment; two writers that both read before either wrote can both land, and the reader credits the first only — the deferred stale-context limitation, unchanged).

**Red run for the Round 3 tests**, five files copied unchanged onto `7ce77ef` before the fix: 12 fail / 52 (`test-collab-obligations.mjs` 2, `test-collab-default-deadline.mjs` 3, `test-collab-eligibility-tick.mjs` 4, `test-collab-wait-cycle.mjs` 2, `test-collab-append-noclobber.mjs` 1). The malformed-types and close-retry tests pass at `7ce77ef`: they map existing guarantees, as Hale asked. Green after the fix: 432 / 432.

**Test-side consequences of the new timing** (fixtures, not semantics): two tick fixtures gained explicit deadlines so their bounds do not lapse inside the test window; the obligations test's `chase()` helper now names the chased participant in `signals`, as the real emitter always did (chases are counted per participant); the July 31 "what the new reader would have done" assertion now expects a fallback per author plus a reminder per other participant.

**Mutation controls (Hale's method correction).** `tests/tools/run-mutations.mjs` applies thirteen targeted mutations, one guarantee each, and requires every one to be caught by the named test files. Run on the candidate: every mutation caught.

| Mutation | Caught by |
|---|---|
| M1 legacy verdict credited before the propose-close | 2 (eligibility, replay) |
| M2 an objection no longer blocks the close outcome | 4 (eligibility ×2, tick ×2) |
| M3 a scoped verdict with a bad id gets partial credit | 1 (disposition) |
| M4 a missing deadline is no deadline | 4 (default-deadline ×3, chase) |
| M5 the fallback waits for the chase sequence again (R3-H1) | 8 (obligations, default-deadline, tick) |
| M6 any referencing verdict delivers a request (R3-M1) | 3 (disposition ×2, tick) |
| M7 the writer gate is skipped | 4 (append-noclobber) |
| M8 contract-invalid never fires | 1 (tick) |
| M9 the stall net ignores the contract | 3 (tick) |
| M10 the validator misses verdict-duplicate | 2 (validate) |
| M11 STATUS.md drops the Measures table | 2 (render) |
| M12 a non-solo kickoff needs no measures | 1 (kickoff) |
| M13 silence credits a measure | 1 (class 18) |

## Round 3, second pass — Hale's candidate review of `d3c4ea4` (`hale-to-muse-candidate-recovery-review-2026-09-11-dd65a67.md`)

Four findings, all reproduced from his descriptions, all fixed tests-first. Red run: the five test additions on `d3c4ea4` → 5 fail / 39 in the four touched files; green after the fix.

- **R3-H1 (still open → fixed).** The scanner ran only on `turn-or-propose`, so a due fallback was skipped while a proposal was on the table. Now obligations run on both decision routes; the precedence (closed → contract-invalid → safety nets → close routes → decision routes) is stated in SKILL.md. Test: `tick/deadline: a pending proposal does not skip a due fallback…` (R1 ticks on `ratify-or-object`, one fallback executed; just-before-deadline control, zero).
- **R3-H2 — identical retry threw `verdict-duplicate`.** The write-time duplicate check now ignores the credit whose event id is the event being written, so a byte-identical retry reaches the idempotent path; changed bytes under the same id still conflict; a fresh id is still refused. Test: `gate/retry: a byte-identical re-append…` (original bytes untouched, one credit).
- **R3-H3 — timeout records never left the machine.** The tick committed chases and nothing else. Now one delivery step at the end publishes everything the tick wrote plus anything `git status` shows pending under the channel from an interrupted tick; nothing pending, no commit. New `gitPendingPaths` helper. Tests in `tests/test-collab-git-delivery.mjs` against a real clone tracking a real bare remote: timeout-only tick → committed, pushed, remote has the file, next tick adds no commit; an orphaned record from an interrupted tick → published by the next tick, not re-executed, only `collabs/` paths in the commit.
- **R3-M1 (still open → fixed).** Legacy bare verdicts were in the delivery map. Only `scope: 'scoped'` credits deliver a request now; the legacy credit itself is unchanged. Test: `disposition: a legacy bare verdict after a propose-close is measure credit, and still delivers no request`.

Hale's four bounded yes answers to the judgment calls are recorded as given: refusal-plus-repair, not automatic recovery, for `contract-invalid`; wall-clock stays `aborted-budget`; the sanitized fixture is accepted as method, not as verified equivalence; the requester executing its own bound grants no reassignment authority and a local record is not proof of downstream delivery.

## Round 3, third pass — Hale's recheck of `c6b0901` (`hale-to-muse-amended-candidate-delivery-review-2026-09-11-8571be3.md`)

R3-H1, R3-H2, R3-M1 closed by Hale at `c6b0901`. Two High findings remained, both on delivery; both reproduced and fixed tests-first (4 red / 6 in `test-collab-git-delivery.mjs` on `c6b0901`, green after).

- **R3-H3 (still open → fixed): interruption after commit, before push.** `gitPendingPaths` read the working tree, so a committed-but-unpushed record looked delivered. `deliverChannel` now inspects every commit ahead of the upstream: if all of them touch only this channel they are pushed, and the push is verified by comparing `HEAD` to `@{u}` afterwards. Test: record committed locally, tick → pushed without a new commit, not re-executed, `delivery.pushed` and `delivery.verified` true. The before-commit control is the existing orphan test.
- **R3-H4: publication had no ownership boundary.** The old step staged the whole channel directory. Now the publisher claims only files under `events/` whose name is their event id and whose author is the ticking participant; the commit is `--only` those paths. Foreign files (a stray draft, another participant's unpublished event) are reported in `delivery.foreign_paths` and left untouched; a modified or deleted tracked file under the channel blocks delivery (`delivery.blocked.reason = 'modified-tracked-files'`); an unrelated unpushed commit blocks the push (`'unrelated-unpushed-commits'`) and is preserved; an unrelated staged entry outside the channel stays staged and uncommitted. Tests, each with the unrelated work actually present and its bytes and remote absence asserted: draft + foreign event beside an owned record; hand-edited committed event; staged README plus an unrelated local commit. No automatic cleanup anywhere.

Mutation controls added: M14 (author check dropped → a foreign event is published) and M15 (unpushed commits ignored → the after-commit record is never delivered).

## Round 3, fourth pass — Hale's review of `8918079` (`hale-to-muse-third-candidate-boundary-review-2026-09-11-5952a2c.md`)

R3-H3 closed by Hale. R3-H4 stayed open on two counterexamples and R3-H5 was new; all three reproduced and fixed tests-first (3 red / 9 in `test-collab-git-delivery.mjs` on `8918079`, green after).

- **R3-H4, committed work judged by location.** The ahead-commit gate checked only the channel path prefix, so a draft *committed* inside the channel was pushed with a clean receipt. Ownership is now evidence in every state: a new event file authored by the participant, or bytes recorded in a per-participant manifest (`~/.collab/delivery/<participant>/<channel>.json`, git blob hashes) when the plugin wrote them — `render()` records STATUS.md, `turns/*.md`, `events.jsonl`; kickoff records `KICKOFF.md` and `events.jsonl`. Commits ahead of the upstream are inspected blob by blob; a committed draft, a deletion, or a committed hand edit to an event (events are immutable, so the author inside a *modified* file proves nothing) blocks the push and is preserved. Tests: committed draft → blocked, remote unchanged, commit preserved; committed edit to the participant's own join event → blocked.
- **R3-H4, sibling routes.** The three close routes rendered and then called the whole-directory publisher (twice, since `render()` also published). `render()` now takes `publish: false` from the tick and records what it writes; the close routes and kickoff call `deliverChannel`; `render()`'s own publish goes through it too. `gitCommitPush` has no remaining caller in the plugin. Test: authority-boundary close with a stray draft present → close event, STATUS.md and events.jsonl on the remote, draft absent and intact, `delivery.foreign_paths` names it.
- **R3-H5, terminal interruption.** The `closed` route returned before any delivery. It now delivers first (owned close event, renders) and then exits. Test: close appended and left untracked, and close appended and committed locally — both reach the remote on the next tick, once, `pushed`/`verified` true, still one close, still `exit closed`; a further tick publishes nothing.

Mutation controls added: M16 (renders not recorded → the close route cannot deliver STATUS.md) and M17 (committed work judged by location → the committed draft is pushed).

## Round 3, fifth pass — Hale's review of `b3fe8ab` (`hale-to-muse-fourth-candidate-render-boundaries-2026-09-11-3c37a3e.md`)

R3-H5 closed by Hale; H4's earlier counterexamples pass. Three new H4 boundary failures, all reproduced and fixed tests-first (3 red / 13 in `test-collab-git-delivery.mjs` on `b3fe8ab`, green after; a fourth test, manifest corruption, is a control that already passed).

- **Path evidence was discarded.** The manifest was flattened to a hash set, so `STATUS.md` bytes copied to `unapproved-copy.md` were published. `isRecordedArtifact(manifest, relPath, hash)` binds ownership to path and bytes; used for uncommitted and committed checks alike. Test: copy of a delivered STATUS.md under a new name → foreign, not published.
- **Excluded content travelled through renders.** `render()` read every local event. On a git transport it now derives STATUS.md, `turns/`, and `events.jsonl` (via `renderEventsJsonl(dir, { include })`) only from publishable events — the participant's own and those the upstream tree holds. Test: unpublished foreign turn with a marker; after the authority-boundary close no file on the remote contains the marker or the event id; the raw file is preserved locally.
- **Ownership was checked after destructive rendering.** `render()` now checks before every write: an existing file is replaced only if its bytes are a recorded render at that path or the upstream's bytes; otherwise it is preserved and reported (`render_blocked: { reason: 'unrecorded-existing-files', paths }`) while the close event itself still delivers. Test: an unrecorded draft `STATUS.md` survives the close, the draft never reaches the remote, the close does.
- **Manifest recovery, bounded as Hale asked:** atomic write (temp + rename); an unreadable or torn manifest reads as empty, which only ever demotes (a render becomes foreign and is preserved); concurrent writers for one participant can lose an entry the same way. Test: truncated manifest → nothing throws, close delivered. Stated in SKILL.md: the manifest is evidence of what this machine's plugin wrote, not participant authentication.

Mutation controls added: M18 (bytes-only ownership), M19 (renders from every local event), M20 (renders overwrite unconditionally).

Agy's spec verification (`agy-to-all-spec-verification-and-delivery-challenge-2026-09-11.md`) signs off on `b3fe8ab`; it states it is based on the posted reports rather than independent execution.

## Round 3, sixth pass — Hale's review of `35cee72` (`hale-to-muse-fifth-candidate-retry-disclosure-2026-09-11-d05a481.md`)

The three fifth-pass controls pass for Hale. One new H4 failure, reproduced and fixed tests-first, plus the manifest-evidence gaps he named.

- **An edited published input contaminated a later retry.** The render's input filter accepted any event whose *path* the upstream held, so a local edit to a published peer turn was derived into recorded renders; delivery blocked on the raw edit, but once the edit was withdrawn the retry pushed the contaminated renders. `publishable(e)` now binds eligibility to bytes: an event the upstream holds counts only if the local file's blob hash equals the upstream blob; an event the upstream lacks counts only if this participant wrote it. That also covers a participant editing their own published event — author equality authorizes nothing about history. Tests: Hale's two-tick control (edit → tick blocks and derives nothing from the edit, edit preserved on disk → withdraw → tick pushes; no marker anywhere on the remote), and the own-author variant.
- **Manifest evidence, as asked.** The corruption test now renders first, asserts the manifest file for that exact channel exists with `STATUS.md` and `events.jsonl` entries, corrupts that file, and asserts the close delivers while the unaccounted-for render is preserved and reported (`render_blocked`). A lost-update control simulates a concurrent writer landing last (manifest overwritten with a stale copy): the forgotten render is preserved on disk, reported, and not published. That is the whole recovery claim — a lost entry demotes, never promotes — and `deliveryManifestPath` is exported so a check can target the file.

Mutation control added: M21 (published input eligible by path, not bytes). M19 retargeted to the new filter body.

## Round 3, seventh pass — Hale's review of `034124a` (`hale-to-muse-sixth-candidate-input-origin-review-2026-09-11-66cf809.md`)

The sixth-pass controls pass for Hale, including his own withdrawal-and-second-tick check. One new H4 reproduction, plus a neighbouring hole found while fixing it; both red first (2 fail / 18), green after.

- **An alternate file borrowed a published event's id.** `readEvents()` accepted any `*.json` and kept the first file per id, while the render filter hashed a file reconstructed from the id — so the shadow's bytes were rendered and the canonical blob was checked. Fix in the reader, for every caller: a file is an event only if its name is `<event_id>.json` (any other name is left in place, warned about, never read as the event), and each event is bound under a symbol to `{ path, hash }` of the exact buffer parsed. The render filter uses that bound evidence — no re-read, so no timing window between check and use; that is the stated concurrent-read guarantee. Test: Hale's shadow control — the reader returns the published bytes for the id, the shadow is listed foreign and preserved, and no marker reaches the remote through any file.
- **A legacy `events.jsonl`-published peer event was dropped from the derived file.** With the exact-bytes filter, an event that exists upstream only as a JSONL line (a v0.1 writer) had no file blob to match and was excluded, so the rendered `events.jsonl` pushed without it. Now an event equal, canonically, to a line of the upstream's `events.jsonl` is publishable. Test: the close delivers an `events.jsonl` that still contains the legacy peer line.

Mutation controls: M22 (reader accepts filename/id mismatch), M23 (legacy JSONL line not an input); M19/M21 retargeted.

## Round 3, eighth pass — Hale's review of `1aa924b` (`hale-to-muse-seventh-candidate-legacy-conflicts-2026-09-11-8969847.md`) and David's filename ruling (`muse-to-all-david-safest-option-2026-09-11.md`)

The shadow and legacy-JSONL controls pass for Hale; M22/M23 verified independently. Two new conflict failures plus a ruling, all red first (4 fail / 22 in `test-collab-git-delivery.mjs`), green after.

- **David's call: fatal block on filename violations.** Implemented as a hard stop at the point where anything could happen: `eventFilenameViolations(collabDir)` lists files under `events/` not named `<event_id>.json`; the tick returns `{ action: 'refused', reason: 'event-filename-violation', paths, repair }` before reading the ledger for routing — nothing appended, derived, or published; `validateEvents(events, { collabDir })` reports each as an error. `readEvents` keeps warning-and-skipping so `status`/`list` can still show a person the channel. Hale's position (warning + exclusion + preservation suffices at the publication boundary) is recorded as dissent; David's ruling governs. The shadow test now asserts the refusal.
- **One published identity, two representations.** A local `events/<id>.json` that contradicts an event published only as an upstream `events.jsonl` line was admitted as a new event (own author) or excluded so that the published line vanished from the derived file (peer). Now: `gitUpstreamJsonl` exposes the upstream's line-published events; the render resolves each local event against both published representations and, on any contradiction, derives from the *published* one (file blob or line), records `{ event_id, path, reason }` in `render_conflicts`, and leaves the local bytes untouched; published events with no local representation are still included. `deliverChannel` no longer owns a new event file whose id is line-published with different content. Tests: own-author and peer JSONL conflicts (nothing of the edit on the remote, published line retained, local bytes preserved, conflict reported, raw file listed foreign); unchanged legacy migration (identical file → not a conflict, delivered); and the edited published *file* case now also keeps the published turn in the derived file.

Mutation controls: M23 retargeted (contradicting line taken as the event), M24 (conflict excluded rather than resolved — published content erased), M25 (tick no longer refuses on a filename violation), M26 (delivery owns a file that contradicts a published line).

**Hale's four fatal-block conditions, mapped.** (a) Every applicable entry point: the refusal is returned before routing, so every tick route — decision, close, and the `closed` exit — is behind it; `render()` publishes only when the tick passes it an author, kickoff writes a fresh directory, and `collab-validate` errors. (b) The refusal happens before any write, so offending bytes, published history, and pending work are untouched by construction; the diagnostic carries paths only, never a body (asserted). (c) Recovery control: a real event of the participant's under the wrong name → refused; operator renames it → the next tick closes once, delivers the renamed event, publishes no unrelated work, keeps published history, and a further tick publishes nothing; the clean-channel success controls are every other close test. Interruption *around* the boundary: there is no write on either side of the check to interrupt. (d) The same-id conflicts are covered by the eighth-pass controls, not by the filename gate. **Tradeoff, explicit:** a stray file under `events/` stops valid work on that channel until a person moves or renames it; `status` and `list` still read the channel (skipping the file) so the stop is diagnosable. That is the availability cost David's ruling accepts.

## Round 3, ninth pass — Hale's review of `f4c04e1` (`hale-to-muse-eighth-candidate-fatal-boundaries-2026-09-11-d92e621.md`)

The legacy conflict fixes, migration, shadow refusal, and refusal/recovery all pass for Hale (39/39 on real remotes); he records R3-H4's legacy disclosure/preservation defects as closed at `f4c04e1`. Two new findings, both red first (2 fail / 26), green after.

- **R3-H6 — a malformed shadow moved valid history before the refusal.** `quarantineInvalidV1Events` ran before the tick's filename gate, read `events/000-shadow.json`, and `quarantineEvent` rebuilt its rename target from the shadow's *event id* — moving the canonical valid `evt-004.json` to `.superseded-evt-004.json` and appending a notice. Now: the tick checks filenames *before* quarantine; `quarantineInvalidV1Events` itself refuses (`report.refused`) when any violation exists and moves nothing; the scan skips any file not named for its id; and `quarantineEvent` acts only on `opts.sourceName` — the file that was read — and throws if asked to act on a misnamed one. Tests: malformed shadow → refused, events directory byte-identical, canonical file untouched, no artifact, no notice, reader still returns the valid turn; direct quarantine call → refused, nothing moved; control — a malformed v1 file under its own name is still quarantined and only it moves.
- **R3-M2 — the hard stop was tick-only.** Direct `render()` and `deliverChannel()` published with a shadow present. Now every write/publish boundary refuses before output: `appendEvent` throws `event-filename-violation`; `render()` returns `refused` and writes nothing (before reconcile); `deliverChannel()` returns `blocked: { reason: 'event-filename-violation' }` and commits nothing. Test: with a shadow and an owned pending event present, all three refuse and the remote is unchanged; after the shadow is removed the same direct calls succeed once.

Mutation controls: M27 (quarantine proceeds with a shadow present), M28 (`deliverChannel` publishes past the stop), M29 (`render` writes past the stop).

## Round 3, tenth pass — Hale's review of `a179f20` (`hale-to-muse-ninth-candidate-primitive-boundary-2026-09-11-7af8a79.md`)

R3-M2 closed by Hale; the H6 tick and scanner paths pass (48/48 on real remotes). H6 narrowed to the exported `quarantineEvent` primitive: called directly with an object parsed from a shadow (or any object carrying a published id), it defaulted its source from the supplied id, checked only the name string, and moved the canonical file. Red first (1 fail / 27), green after.

- `quarantineEvent` now refuses before any mutation while any filename violation exists in the channel (the same hard stop as every other boundary, enforced in the primitive because it is exported), and refuses with `quarantine-source-mismatch` unless the supplied event, re-serialized with `JSON.stringify`, equals the re-serialized parse of `events/<id>.json` — a parsed-object comparison that is sensitive to key order and is neither raw-file byte equality nor order-independent canonical JSON (Hale's wording correction, tenth-pass review); the artifact is written from the source file's parsed content, not the supplied object. A caller can no longer retarget canonical history by handing the function an id it did not read. Test: shadow present → refused, nothing moved (with and without `sourceName`); no shadow but a tampered supplied object → refused, canonical untouched, reader unchanged; clean malformed same-name file → quarantined from source bytes, only it moves.

Mutation controls: M30 (primitive trusts the supplied object), M31 (primitive ignores channel-wide violations). The receipts' boundary list now holds for the primitive as well; it is not declared an internal trusted primitive.

## Eleventh pass — CI on PR #6 (2026-09-12, Linux runner)

CI failed 6/462 on `54e7ed8` while the local suite was 462/462. Two causes, both environmental dependencies the local run had hidden:

- **Five delivery tests** (modified tracked file, unrelated staged entry, edited published input ×2, edited peer file) threw `git pull failed … cannot pull with rebase: You have unstaged changes`. `gitPullRebase` ran a plain `git pull --rebase`; on the developer's machine `~/.gitconfig` had `rebase.autostash true`, on the runner it did not. The product depended on user config. Fix: `--autostash` is passed explicitly, with the stash-pop-conflict ceiling stated in a comment. The test file now runs every git call, product included, against an empty `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_NOSYSTEM=1`, so the red reproduces locally (5/27 before the fix, 27/27 after). Mutation control **M32** removes `--autostash` and is caught.
- **`test-collab-rejected-join-authorization.mjs`** (on `next` since July, not this branch) imported the helpers through a hardcoded `/Users/dbates/…` path when `COLLAB_SRC` was unset. Now resolves relative to the test file. `next` had been red on this file before this PR; the PR body did not say so and should have.

Full suite 462/462 (`node --test tests/test-*.mjs`, `~/Documents/Projects/collab-plugin`); mutation controls 32/32 caught (`node tests/tools/run-mutations.mjs`). The claim "462/462" in earlier passes was true on one machine's git config and is now true against an empty one.

## Out of scope, recorded

Stale-context detection between read and append (the reread convention is documented with its race); participant identity; transport defaults; never-closed sessions; wall-clock extension.
