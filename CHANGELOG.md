# Changelog

All notable changes to collab-plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Added
- Three-harness manifests (Claude Code, Codex, Gemini), SKILL.md placeholder, five scripts, CI workflows.
- `collab-event-helpers.mjs`: shared event I/O, triplet derivation, slug resolution, git transport.
- `collab-validate.mjs`: schema validation for events.jsonl.
- `collab-render.mjs`: STATUS.md and turns/*.md from events.jsonl; git commit + push.
- `collab-kickoff.mjs`: slug derivation, IGM scaffolding, KICKOFF.md + kickoff/self-join events.
- `collab-tick.mjs`: deterministic state-machine routing, safety nets, ratification tracking.
- `collab-status.mjs`: terminal status display (read-only, no event emitted).
- `references/capabilities.md`: starter capability vocabulary.
- `references/igm-derivation.md`: IGM inference template.
- CI: syntax check, manifest validation, harness lockstep, SKILL.md frontmatter, unit tests.
