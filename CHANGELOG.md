# Changelog

All notable changes to collab-plugin are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning: [SemVer](https://semver.org/).

## [0.2.0] — 2026-05-25

Minor release. Transport modes (`localhost` + `github:<repo>`), one-event-per-file event store, decoupled ratification window, harness detection fallback chain, transport preflight, strict slug uniqueness, and `min_collab_plugin_version` enforcement on join.

### Added
- **Transport modes.** `/collab [transport] <message>` accepts `localhost` (events at `~/.collab/local/`, no git) and `github:<repo>` (events in `~/Documents/Projects/<repo>/collabs/`). Default when omitted: `github:files` (v0.1.x behavior preserved).
- **One-event-per-file event store.** Canonical store moves from a single `events.jsonl` to `events/evt-<YYYYMMDDHHmm>-<author-slug>-<4hex>.json`. `events.jsonl` becomes a derived render artifact. Atomic temp→rename writes; reader filters `.tmp-` prefix files; first-wins dedup on duplicate event_ids; malformed-file warn-and-skip on both `events/` and JSONL fallback paths.
- **Decoupled ratification window.** `ratification_window_minutes` becomes its own kickoff payload field, no longer locked to `3 × tick_interval_minutes`. Localhost floor: 30 minutes regardless of tick cadence.
- **Harness detection fallback chain.** `detectHarness()` priority: `CODEX_PLUGIN_ROOT` → `'codex'`; `GEMINI_PLUGIN_ROOT` → `'gemini'`; `COLLAB_HARNESS_OVERRIDE` → use verbatim; else `'claude-code'`. Closes Phase 3 finding #15 — Gemini's `core-gemini@claude-code:...` misidentification.
- **Transport preflight.** Before any event append, `preflightTransport()` confirms read+write at the collabs root for the chosen transport. Surfaces permission errors with a human-readable message.
- **Strict slug uniqueness across transports.** Kickoff fails if the slug exists in any transport. Removes a class of disambiguation prompts; makes slug → transport a total function.
- **`min_collab_plugin_version` field on kickoff payload.** Joining agents on older versions refuse with the canonical error: *"This collab requires collab-plugin >= `<min>`; this install is on `<local>`. Upgrade and retry."* `readLocalPluginVersion()` walks the CODEX/GEMINI/CLAUDE/COLLAB env-var chain so all three harnesses resolve correctly.
- **`collab-list.mjs`** — cross-transport listing helper. Auto-detects all `github:<repo>` transports by scanning `~/Documents/Projects/`. Filter with `--active` (default), `--closed`, or `--all`.
- **`transport.mjs`** module — `resolveTransportPaths`, `isGitTransport`, `defaultTickIntervalMinutes`, `defaultRatificationWindowMinutes`, `preflightTransport`, `detectHarness`, `parseTransport`, `collabsRootForTransport`. The single source of truth for transport behavior.

### Changed
- **Localhost default tick cadence: 2 minutes.** Override per-kickoff with `--tick-interval-minutes <n>` (use `1` for high-stakes adversarial reviews where objections need to land in under a minute).
- All scripts route storage through `transport.mjs`. No script hardcodes `~/Documents/Projects/files/` anymore.
- `gitPullRebase(transport)` and `gitCommitPush(collabDir, transport, commitMsg)` now require a transport arg; called only when `isGitTransport(transport)` is true.
- `collab-status.mjs` accepts `--transport <id>` for disambiguation; auto-resolves via `findCollabAcrossTransports` when transport not given.
- `collab-route.mjs` parser extracts a leading transport token (`localhost` or `github:<repo>`). Verb prefixes are split into discourse (`look at|talk about|discuss|review|join`, safely stripped) and routing (`abort|cancel|status of`, preserved so `detectAction` can still route them).
- Self-join event timestamp bumped by 1ms over kickoff timestamp so `readEvents` deterministically sorts kickoff first.

### Backward compatibility
- v0.1.x collabs with only `events.jsonl` (no `events/` dir) are still readable. `readEvents()` falls back to the JSONL path with a warning.
- v0.1.x kickoff events without `transport` are treated as `github:files` at read time. Validator emits a warning, not an error.
- v0.1.x kickoff events without `min_collab_plugin_version` skip the version check.
- v0.1.x kickoff events without `ratification_window_minutes` fall back to `3 × tick_interval_minutes`.
- `/collab <message>` (no transport prefix) still works — defaults to `github:files`.
- **Writes to a v0.1.x hybrid layout (events.jsonl present, events/ absent) are refused** with a clear error. Per spec §9.6 compat is read-only; the refusal prevents silent history-stranding.

### Known limitations (v0.2)
- **Concurrent kickoff race.** Two agents that kick off the same slug at the exact same instant both pass `assertSlugUnique` before either writes; the second overwrites the first. Acceptable because David's two-touchpoint model is sequential. A lockfile would close it in v0.3 if needed.
- **No automatic v0.1.x → v0.2 migration.** Hybrid layouts refuse writes; manual migration is required (split events.jsonl into one file per line under events/).

### Tests
- 28 new tests across `test-transport.mjs`, `test-event-store.mjs`, `test-version-check.mjs`, `test-collab-list.mjs`, plus additions to route/kickoff/tick/validate/render/e2e. New end-to-end test that drives kickoff → propose-close → ratify → close on the real localhost transport. Suite total: 111 → 178/179 (one pre-existing tick-cadence test unchanged).

## [0.1.4] — 2026-05-25

Patch release. Word-boundary slug truncation + cross-harness SKILL.md path portability.

### Fixed
- **`deriveSlug()` word-boundary truncation:** slugs longer than 50 characters are now cut at the last hyphen at or before 50 chars rather than mid-word. Previously `/collab "v0.2 spec rework collab plugin transport modes spec against the changelist"` produced `rework-collabplugin-v02-transportmodes-spec-agains` (mid-word). Now produces a clean word-boundary slug.
- **SKILL.md cross-harness path portability:** all 8 script path examples changed from `${CLAUDE_PLUGIN_ROOT}` to `${COLLAB_PLUGIN_ROOT}` with a note at the top explaining the per-harness substitution (`${CLAUDE_PLUGIN_ROOT}` on Claude Code, `${CODEX_PLUGIN_ROOT}` on Codex, `${GEMINI_PLUGIN_ROOT}` on Gemini CLI). Prevents Codex and Gemini from reading examples as literal `${CLAUDE_PLUGIN_ROOT}` strings.

### Tests
- 2 new tests in `tests/test-collab-kickoff.mjs` covering word-boundary truncation. Suite total: 111 tests.

### Design notes
- `deriveSlug()` now: (1) build full slug, (2) if ≤50 chars return as-is, (3) truncate to 50, (4) find last hyphen in truncated string, (5) cut there. Falls back to hard 50-char cut only when there is no hyphen in the first 50 chars (extremely long single-word slug).
- `${COLLAB_PLUGIN_ROOT}` is a documentation convention, not a new env var. The actual env var each harness sets differs; the note tells the reader which to use.

### Backward compatibility
- `deriveSlug()` change is backward-compatible for messages that produce slugs ≤50 chars (no change). Longer messages get cleaner slugs.

## [0.1.3] — 2026-05-25

Patch release. 6-digit PIN as David's manual-entry shorthand for `/collab`.

### Added
- 6-digit `pin` field on the kickoff event payload, auto-generated by `collab-kickoff.mjs` (or supplied via `--pin <6-digits>` for testing). The kickoff CLI prints the PIN prominently in its stdout summary alongside the slug and `/loop` command.
- Bare-PIN routing: `/collab 654321` (or `/collab localhost 654321`) is detected by `collab-route.mjs` and resolved to the corresponding full slug via the `pinIndex` built from disk. Action defaults to "look at" semantics — join if not yet joined, tick if already joined. `/collab abort 654321` and `/collab status 654321` work the same way.
- `generatePin()`, `isPinRef()`, and `resolveCollabByPin()` helpers in `collab-event-helpers.mjs`.
- Validator: `pin` is optional on kickoff; if present must be a 6-digit string.
- 19 new tests in `tests/test-collab-pin.mjs`. Suite total: 109 tests.

### Design notes
- **PIN is David's manual-entry shorthand, not an agent-facing identifier.** Agents continue to communicate by slug throughout — in event payloads, peer messages, and status reports. The PIN exists solely so David can start an agent on a topic with minimal typing; once resolved at the route entry point, everything downstream uses the slug.
- PIN lives in the kickoff event payload, not in the slug or directory name. The slug stays semantic and meaningful; the date in the directory name and event timestamps provide additional disambiguation if ever needed.
- Forward-only: existing closed collabs are not retrofitted with PINs. Their references continue to work via the full slug.

### Backward compatibility
- Kickoff events without `pin` still pass validation; route resolution still works via slug names. No v0.1.2 behavior changes.

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
