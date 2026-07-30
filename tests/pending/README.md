# Pending tests — proven red, waiting on a decision

These tests fail against current code. That is the finding, not a defect in the tests.

They are deliberately outside the CI glob (`tests/*.mjs`), so they neither break the build
nor get marked `todo`. Marking a real gap `todo` is how a previous release turned an honest
admission into a silent pass at the CI gate; this directory exists so that cannot happen
again.

Each one was proven to discriminate before landing here: red against the shipped code, green
against a minimal reference implementation, and red again under mutations of that
implementation. A test that has only ever been red proves nothing either.

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

## test-collab-harness-identity.mjs — failure class 11

Clearing the harness environment must not change who a participant is.

Red against shipped code, reproducing the live `core-gemini@claude-code` mislabel
mechanically. There is no `participant_id`: identity *is* the triplet
`workspace@harness:machine`, and `deriveTriplet()` recomputes `detectHarness()` on every
call. The harness is not an advisory field beside identity, it is a substring of it, so a
changed environment renames the participant rather than degrading a label.

Wider than the name: `cursorFilePath()` partitions cursor state by harness and embeds the
triplet in the filename, so the same defect silently resets a participant's read position.

**The decision this waits on:** minting and persisting a stable `participant_id` at join is a
schema change that every existing channel has to tolerate.
