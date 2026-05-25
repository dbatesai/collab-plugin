# Changelog

All notable changes to collab-plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [SemVer](https://semver.org/).

## [0.1.2] — 2026-05-25

Patch release. Per-collab tick cadence + Codex YAML compatibility for SKILL.md frontmatter.

### Added
- Configurable tick cadence via `--tick-interval-minutes <n>` on `collab-kickoff.mjs` (default 30; valid range 1–1440). The value is written to the kickoff event's payload as `tick_interval_minutes` and read by all safety-net calculations.
- `getTickIntervalMs(events)` helper in `collab-event-helpers.mjs`. Single source of truth for per-collab tick cadence; falls back to the 30-min default when the field is absent.
- Per-collab safety-net scaling: the stall threshold (6 × tick) and silence-as-ratification window (3 × tick) now scale with the kickoff's cadence. A 5-min-cadence collab stalls at 30 min and ratifies silence at 15 min; a 30-min-cadence collab keeps v0.1.1 behavior (180 min stall, 90 min silence-ratify).
- `collab-route.mjs` join-route output now includes `tick_interval_minutes` so SKILL.md can recommend the right `/loop <n>m` command.
- Validator (`collab-validate.mjs`): `tick_interval_minutes` is optional on kickoff; if present must be a number in `[1, 1440]`.
- 11 new tests in `tests/test-tick-cadence.mjs` covering helper return values, stall scaling, and silence-ratify scaling. Suite total: 90 tests.

### Fixed
- **SKILL.md frontmatter:** `description` value now quoted so YAML parsers don't interpret embedded colons as mapping keys. Codex was rejecting v0.1.1 with `invalid YAML: mapping values are not allowed in this context at line 2 column 126` and skipping skill load entirely. Quoting the string also escapes the colon-style enumeration ("five paths: kickoff, ...") which is now rendered as an em-dash.

### Backward compatibility
- Kickoff events without `tick_interval_minutes` keep v0.1.1 behavior (30-min cadence, 90-min silence-ratify, 180-min stall). All v0.1.1 tests still pass unchanged.
- `TICK_INTERVAL_MS` and `SILENCE_RATIFY_MS` constants kept as exported defaults.

## [0.1.1] — 2026-05-25

The meaningful v0.1 release. (v0.1.0 fired from a CI auto-tag after the Phase 1 scaffold pushed; the plugin wasn't actually usable end-to-end until this release.)

### Added
- Agent-first README with all 10 spec §11 sections + worked example + known-limitations doc.
- Silence-as-ratification (`SILENCE_RATIFY_MS = 3 × TICK_INTERVAL_MS`, 90 minutes): joined peers who emit no events for 90+ minutes after a propose-close are implicitly ratified. Handles offline peers (usage limits, machine crashes, network issues) without stalling convergence. Explicit ratify/object events still override silence.
- 27 new tests: 6 silence-as-ratification (test-collab-tick), 8 cross-harness identity (test-detect-harness), 8 end-to-end + regression (test-collab-e2e-lifecycle), 5 SKILL.md prose lint (test-skill-md-prose). Total suite: 79 tests.
- SKILL.md prose hardening: explicit `signals: []` in payload examples, body-vs-synthesis distinction called out per event type, all 5 close outcomes enumerated.

### Changed
- `getRatificationStatus(events, nowTs)` now distinguishes `explicitRatified` from `implicitRatified` (combined into `ratified`); takes an optional `nowTs` for injection in tests. Inline propose-close lookup preserves queryability after objections so callers can read `objected` and `converged` without losing the active context.
- `collab-tick.mjs` routing tightened to gate on `objected.length === 0` so the new ratification semantics don't change behavior for objected propose-closes.

### Fixed (v0.1 → v0.1.1 findings caught during Phase 3 cross-harness validation)
- Finding #1: `signals` field on turn events documented as required (was reading optional in SKILL.md prose).
- Finding #2: `body` (turn) vs `synthesis` (propose-close) payload distinction made explicit.
- Finding #3: SKILL.md and README use harness-conditional `${CLAUDE_PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}` / `${GEMINI_PLUGIN_ROOT}` paths in examples.
- Finding #4: README clarifies that the repo is a single-plugin root (not a marketplace root) and documents the per-harness install pattern.
- Finding #7: silence-as-ratification implemented (was spec'd but not in code). See "Added" above.

### Known limitations (deferred to v0.2)
- Finding #5: No supersede/errata semantics for malformed events. Once an event lands in events.jsonl, the validator will always flag it. v0.2 will add explicit `supersedes` envelope semantics or an "errata" event type.
- Finding #6: IGM refinement via clarify turn doesn't propagate to STATUS.md (STATUS.md renders the kickoff IGM only). v0.2 will fix.

### Validated end-to-end
- Cross-machine git transport (HK on MacBook Pro M5 Pro ↔ WK on MacBook Pro M4 Pro via files repo).
- Cross-harness install + script execution (Claude Code + Gemini + Codex, all running Node.js scripts unmodified).
- Cross-skill layering (BBLens-over-CORE on WK didn't interfere with collab-plugin).
- First-class objection mitigation (Codex's critique in Phase 3 pre-objected to a false-convergence, exactly as `risk-9-bad-infrastructure-convergence` is designed to handle).

## [0.1.0] — 2026-05-25

Scaffold-only auto-tag from CI. See [0.1.1] for the actual v0.1 release content.

### Added
- Three-harness manifests (Claude Code, Codex, Gemini).
- Six scripts: `collab-event-helpers.mjs`, `collab-validate.mjs`, `collab-render.mjs`, `collab-kickoff.mjs`, `collab-tick.mjs`, `collab-status.mjs`.
- SKILL.md placeholder (functional manual landed in 0.1.1).
- References: `capabilities.md`, `igm-derivation.md`.
- CI: syntax check, manifest validation, harness lockstep, SKILL.md frontmatter, unit tests (52 at scaffold).
- `collab-route.mjs` deterministic message routing (DC-77).
- `collab-tick.mjs` refactor: `tickDeterministic()` handles deterministic paths only; LLM-decision routes exit with `{action: 'agent-decision-needed', route, ...}`.
