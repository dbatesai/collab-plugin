# Pending tests — proven red, waiting on a decision

These tests fail against current code. That is the finding, not a defect in the tests.

They are deliberately outside the CI glob (`tests/*.mjs`), so they neither break the build
nor get marked `todo`. Marking a real gap `todo` is how a previous release turned an honest
admission into a silent pass at the CI gate; this directory exists so that cannot happen
again.

Each one was proven to discriminate before landing here: red against the shipped code, green
against a minimal reference implementation, and red again under mutations of that
implementation. A test that has only ever been red proves nothing either.

**A red test only means something if it is red for the reason it claims.** The first commit
into this directory got that wrong: two files landed with imports one level short, so both
died on `ERR_MODULE_NOT_FOUND` before a single assertion ran — inside the same commit whose
README said exactly that must not happen. Nobody read the failure; the summary line said
"fail" and that matched what was expected. A sibling agent running them caught it.
`tests/test-pending-tests-fail-honestly.mjs` now runs every file here on each CI pass and
fails the build if any of them passes, or fails on anything other than an assertion.

## test-collab-peer-silence-terminal.mjs — failure class 18

A goal blocked on a review that is itself a ratified completion measure must terminate as
`complete-to-authority-boundary` or `failed-safely`. It must not claim `converged`, and it
must not synthesize the missing accept.

Four of six assertions are red. The reason is not a missing guard — it is that the shipped
mechanism does the forbidden thing on purpose. `getRatificationStatus` converts any silence
past the ratification window into an implicit ratify, unconditionally, with no notion of a
required reviewer. `detectRoute` then returns `emit-close` and the close is written as
`converged`. `VALID_OUTCOMES` has no word for the honest outcome, so a blocked goal cannot
currently be recorded as blocked even by hand.

This is the mechanism behind the 2026-07-30 stall, where a goal only moved because a human
noticed. It was also observed on 2026-05-26, when a peer's silence formally closed a design
whose substantive review had never been delivered.

**The decision this waits on:** silence-as-ratification is a real ratified feature that keeps
an offline peer from wedging convergence forever. The fix is a narrowing — required reviewers
only — not a repeal. One test in the file is a control that fails loudly if someone
implements "silence never ratifies" and strands every offline peer instead. Prose in
`SKILL.md` and the README teaches the current behavior and changes with the code.

## test-collab-recovery-election.mjs — failure class 13

Simultaneous recovery attempts must not elect two writers.

All seven assertions are red, and the defect was reproduced before the test was written: two
barriered processes both ran recovery on one broken lane, both imported the orphan, and both
wrote a `reconciled` receipt. Two writers, no error, no claim artifact on disk.

There is no recovery election. `acquireRepoClaim` is the only mutual-exclusion primitive and
it guards git operations only — `reconcileForeignSurface`, which is the actual recovery path
and does mutate reconciliation state, runs under no claim at all. On a `localhost` channel
there is no claim in play whatsoever.

Ten consecutive runs against a reference implementation: green 10/10. Ten against a
check-then-write mutation of that implementation: green 0/10, with the contention case
catching it every time. No flake in either direction.

**The decision this waits on:** the function names are invented (`acquireRecoveryClaim` and
family, matching the existing `acquireRepoClaim` shape) because the design specifies a
mechanism, not an API. An implementer who picks different names should rename in the test
rather than weaken it.

## test-collab-harness-identity.mjs — failure class 11 — RESOLVED, moved to `tests/`

Clearing the harness environment must not change who a participant is.

The decision it waited on was taken: a `participant_id` is minted once and persisted, the
triplet is frozen at mint, and `harness` became an advisory field beside identity rather than
a substring of it. `cursorFilePath()` no longer partitions by harness. The test lives at
`tests/test-collab-harness-identity.mjs` and CI protects it there; the compatibility read for
channels whose join events predate participant ids is covered by
`tests/test-collab-legacy-participant-id.mjs`.
