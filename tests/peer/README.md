# tests/peer

Peer reproducers and fixtures, promoted verbatim from a reviewer's own check and kept apart from the plugin's own tests.

Conventions (settled by Keel, Hale and Agy, 2026-09-12):

- A file here imports the plugin's public exports and nothing from `tests/`, and builds its own remote. It must not depend on the developer's git configuration; every `git` call sets its own identity and ignores the global config.
- The header names the reviewer, the candidate, the prior candidate on which it fails, and the assumption it encodes, with a link to the original revision.
- **The assumption is preserved, including setup.** A setup or import edit can point a check at a different export or a local ref with every assertion still green, so a change to the encoded assumption is reviewable. An assertion change is a new test.
- The receipt records authorship and execution as separate facts per control. A fixture that has been built and mechanically checked has not been run by a reader; that is a different fact and is recorded by whoever runs it.

Contents:

- `handoff-controls/` the three review-handoff controls Keel owes after v1: a clean authorized baseline, a moved base, and a code fix with authority removed.

The receipt shape that records these controls, including the boundaries and controls table, is `docs/specs/receipts-template.md`.
