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

## Out of scope, recorded

Stale-context detection between read and append (the reread convention is documented with its race); participant identity; transport defaults; never-closed sessions; wall-clock extension.
