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

## Out of scope, recorded

Stale-context detection between read and append (the reread convention is documented with its race); participant identity; transport defaults; never-closed sessions; wall-clock extension.
