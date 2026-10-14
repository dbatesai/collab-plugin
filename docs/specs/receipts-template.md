# Receipts template

Use this shape for the receipt of any candidate that goes to a peer for review. It records what exists and what was run. It authorizes nothing: a peer receipt is evidence, not permission. Authority is verified by the quoted instruction, and code by the remote. (Conventions settled by Keel, Hale and Agy on 2026-09-12; first worked example: `tests/peer/handoff-controls/`.)

## Header

- **Candidate:** branch, full head SHA, base SHA, and what changed above the base in one sentence.
- **Authority:** the quoted instruction that governs this work, with who gave it and when. The receipt does not itself authorize a merge, a release or an install.
- **Review shape:** shared SHA, contract, threat assumptions, known findings. First-pass checks are recorded separately, each posted with a reply-by time even if still running; an unfinished run stays pending and is never counted as signoff.

## Commits

| WP | Commit | What |
|---|---|---|

## Red before, green after

Each file run alone. "Red" is the file's result at the base. State the exact command.

| File | Red at base | Green on candidate | Notes |
|---|---|---|---|

## Boundaries and their controls

One row per boundary the candidate changes or relies on. A boundary with no row has no stated prevention. Only an **executed** control proves prevention; an authored one proves only that a check exists.

| Boundary | Mutation control (what is changed to try to cross it) | Observable unchanged state (what must still be true afterward) | Clean success control (the same path with nothing wrong) | Repair or retry path | Evidence requirement | Authored by, when | Executed by, when, result |
|---|---|---|---|---|---|---|---|

Rules for the table:

1. **Name the affected check, not a broad stop.** The control says which check the changed input touches and what re-running it shows. "Stop" is the outcome only for a failed check or a lapsed authority.
2. **Authorship and execution are separate facts.** A row filled "authored" with an empty execution cell is honest. Do not write "tested" for a control no one has run.
3. **Fetch detects; it does not protect.** A row that relies on the remote not having moved states what it checks at the moment of use, not at fetch time.
4. **A receipt authorizes nothing.** No row may be read as permission to proceed. The authority line in the header is the only authority, and it is quoted.
5. **Residuals are rows too.** A window the design does not close (for example a write between a re-read and a rename) is listed as a boundary with its control "none" and its evidence requirement "not provided", rather than omitted.

### Worked rows (from the handoff controls fixture)

| Boundary | Mutation control | Observable unchanged state | Clean success control | Repair or retry path | Evidence requirement | Authored | Executed |
|---|---|---|---|---|---|---|---|
| The remote moved after the receipt | A commit lands on the remote's `main` that changes only `lint.config.json` | The receipt's base and candidate are as written; `parse.mjs` is unchanged | S1: remote at the receipt's base, both checks run and pass | Name `lint-check` as the affected check, re-run it, proceed if it passes | The reader's record names the check and shows the re-run | Keel, 2026-10-14 (`tests/peer/handoff-controls/`) | Not run by a reader |
| Authority withdrawn after the code was fixed | A later entry in the authority log withdraws the go-ahead | The patch and both checks are as they were | S1 | Stop, name the lapsed authority, quote the later instruction; resume only on a new quoted go-ahead | The reader's record quotes the withdrawal | Keel, 2026-10-14 | Not run by a reader |

## Handoff record, five fields (when the receipt is read by another agent)

Transition. Available context (each item with its author and the kind of assistance). Extra lookups. Justified next action or named stop. Observed outcome. Record successes as well as failures. Independence is limited by what the reader already knew; do not strip authority or safety context to make a read "cold".

## Residuals and limits

What was not covered, what depends on an assumption, what only the owner ran.
