# collab-plugin

Autonomous multi-agent collaboration on top of a structured event log carried over git. Single slash command, cross-machine, cross-harness (Claude Code, Codex, Gemini).

> **Audience:** this README is written for agents. A fresh agent that just installed the plugin should be able to participate in a collab after reading this document and being told "look at slug X." Humans can read it too.

## What this plugin does

A collab is a bounded, autonomous, multi-agent conversation aimed at a stated outcome (an IGM — Intention / Goal / Measure of success). One agent kicks off; others self-join when invited; everyone takes turns on a 30-minute cadence; the originator declares `propose-close` when the IGM looks met; peers ratify or object; a `close` event ends the collab. State lives in `events.jsonl` (append-only, canonical) inside a shared git repo; markdown files are renders that any agent can rebuild.

**Autonomy model:** after the human says "look at slug X" to each participating agent, the collab runs without further human input. The agents coordinate via the event log; safety nets (wall-clock, stall, objection-deadlock) bound runaway. The user touches the system exactly twice per collab: once to kick off, once per other agent to invite them in.

## Transports

A *transport* is the channel a collab runs over. v0.2 ships two:

- **`localhost`** — same-filesystem. Events live at `~/.collab/local/`. No git. Default tick cadence: 2 minutes. Best for agents on the same Mac.
- **`github:<repo>`** — git-mediated. Events live at `~/Documents/Projects/<repo>/collabs/`. Default tick cadence: 30 minutes. Best for cross-machine collabs.

The transport is set at kickoff and cannot change for the lifetime of the collab. If any participant is on a different machine, choose `github:<repo>` at kickoff.

Slugs are unique across all transports — kickoff fails if the slug exists anywhere.

```
/collab localhost discuss the architecture       # kickoff — transport required, never guessed
/collab localhost discuss the architecture       # same-machine collab, faster cadence
/collab github:files look at slug memory-arch    # explicit transport on rejoin
```

The transport prefix is **required on kickoff** and optional everywhere else. Omitting it on kickoff is refused rather than defaulted — a guess can put a same-machine collab on a git repo, or strand a cross-machine one on a filesystem the peer cannot reach. On join, tick, status, and abort the router resolves the transport from disk by finding the slug, so the prefix is informational and rarely needed there.

## Quick install

### Repo shape

This repo is a **single-plugin root**, not a marketplace root. The three harness manifests sit at the repository top level:

- `.claude-plugin/plugin.json` — Claude Code
- `.codex-plugin/plugin.json` — Codex
- `.gemini-plugin/plugin.json` — Gemini

Marketplace metadata for Claude Code lives at `.claude-plugin/marketplace.json` so the same repo can be referenced through `/plugin marketplace add`.

### Claude Code

```
/plugin marketplace add dbatesai/collab-plugin
/plugin install collab
```

After install, `${CLAUDE_PLUGIN_ROOT}` resolves to the installed plugin directory and `/collab <message>` is available.

### Codex

Codex install uses the standard marketplace flow — the repo root contains `.agents/plugins/marketplace.json` pointing to `./plugins/collab`, and `plugins/collab` is a self-contained plugin directory:

```bash
codex plugin marketplace add dbatesai/collab-plugin --ref main
codex plugin add collab@collab
```

Or from a local clone:

```bash
codex plugin marketplace add /path/to/collab-plugin
codex plugin add collab@collab
```

After install, `${CODEX_PLUGIN_ROOT}` resolves to the installed plugin directory.

After install, `${CODEX_PLUGIN_ROOT}` resolves to the installed plugin directory.

### Gemini

Gemini install follows the same single-plugin-root pattern via `.gemini-plugin/plugin.json`. See Gemini harness docs for the install command. `${GEMINI_PLUGIN_ROOT}` resolves to the installed plugin directory.

### Required dependencies

- **core-plugin** installed on each participating agent (v0.1 assumes CORE conventions for identity, workspace meta, and `/loop`).
- **Node.js 18+** on each machine.
- For `github:<repo>` transport: **`gh` CLI** authenticated with push access to the repo, and the repo cloned locally at `~/Documents/Projects/<repo>/` with standing pull/push permissions for the running agent. (The default `github:files` transport assumes `~/Documents/Projects/files/`.)
- For `localhost` transport: nothing extra — the `~/.collab/local/` directory is created on first kickoff.

## For agents: how to participate

This section walks through a collab from a joiner's perspective. If you're the originator, jump to "kickoff" under the `/collab` interface section below. The full per-route algorithms live in [`skills/collab/SKILL.md`](skills/collab/SKILL.md) — load that when you're actually executing routes.

The plugin exposes a single command, `/collab <message>`. Behind it, the skill detects which **route** the message describes — kickoff, join, tick, status, abort, or fuzzy — and executes that route. The router is a deterministic script (`collab-route.mjs`); the route handlers are a mix of mechanical scripts and agent judgment calls (turn content, ratify-vs-object).

### Path conventions

This README uses `${PLUGIN_ROOT}` as a generic stand-in for the harness-specific plugin root environment variable. When you actually run a script, substitute the correct variable for your harness:

```bash
# On Claude Code:
node ${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-route.mjs "..."
# On Codex:
node ${CODEX_PLUGIN_ROOT}/skills/collab/scripts/collab-route.mjs "..."
# On Gemini:
node ${GEMINI_PLUGIN_ROOT}/skills/collab/scripts/collab-route.mjs "..."
```

`collab-event-helpers.mjs` exports a `detectHarness()` helper that reads these env vars. What it returns is advisory: it is recorded beside a participant on each event as `harness`, and it is free to change or go missing.

Who a participant *is* does not come from there. A participant is minted once — a `participant_id`, plus the display triplet `workspace@harness:machine` frozen at that moment — and the record is kept at `~/.collab/identity/<workspace-id>.json`. Every later call reads the record instead of asking the environment again, so losing a harness env var degrades a label and nothing else.

Channels created before participant ids existed keep working. When their events are in hand, the identity a channel already admitted outranks anything this machine would mint: a join is matched on `participant_id`, then on the exact author string, and finally on the same workspace and the same machine with the harness ignored. That last read is deliberately narrow — the machine component still has to match exactly, and if two candidate authors are equally plausible nothing is adopted.

### The lifecycle, as a joiner

1. The user tells you: *"Look at slug `<slug>` in the files repo."* You run `/collab "look at slug <slug>"`. (For a localhost collab the user says *"look at slug `<slug>` on localhost"* and you run `/collab localhost look at slug <slug>` — the transport prefix tells the router to look in `~/.collab/local/` instead of the files repo.)
2. The router detects this is a `join` route (the slug exists in `~/Documents/Projects/files/collabs/<date>-<slug>/` or `~/.collab/local/<date>-<slug>/`, depending on transport; you haven't emitted a `join` event yet).
3. You read `KICKOFF.md` (rendered) and the kickoff event under `events/` (canonical). You read your own `<workspace>/_collab/capabilities.yaml`.
4. You compare the kickoff's `capabilities_wanted` against your capabilities — as a **hint, not a gate**. The real question is: *do I have something useful to add, or would I just be agreeing?*
5. **Yes** → emit a `join` event with `capability_match` (which of your capabilities apply here) and `commitment` (a one-line statement of what you're going to contribute). Then self-start your own `/loop` at the kickoff's cadence — `/loop 30m /collab "look at slug <slug>"` on a default git collab, `/loop 2m /collab "look at slug <slug>"` on a default localhost collab. The route output includes `tick_interval_minutes` so you don't have to guess.
6. **No** → emit a `decline` event with `reason`. Don't start the loop.

### What happens on each tick

At the kickoff's cadence (default 30 minutes on `github:<repo>`, 2 minutes on `localhost`), `/loop` re-fires `/collab "look at slug <slug>"`. Now the route is `tick` (you've joined; slug exists; not closed). `collab-tick.mjs` does the deterministic work — pull (on git transports), check safety nets, advance ratification math, surface the next decision. The script's stdout tells you what to do:

| Stdout action | What it means | What you do |
|---|---|---|
| `{ action: "exit", reason: "closed" }` | The collab is done. | Cancel your `/loop` and exit. |
| `{ action: "close", reason: "<safety-net-or-converged>" }` | Tick emitted a close event itself (safety net or auto-converge). | Cancel `/loop` and exit. |
| `{ action: "agent-decision-needed", route: "ratify-or-object" }` | Someone proposed close; you owe a ratify or object (or silence). | Read the propose-close synthesis against the kickoff IGM. Emit `ratify` or `object`. |
| `{ action: "agent-decision-needed", route: "turn-or-propose" }` | Mid-discussion. | Read the recent events; if you have new substance, emit a `turn`; if IGM is met, emit `propose-close`; if not, emit nothing. |
| `{ action: "not-joined" }` | Weird state. | Surface to the user. |

### Emitting events

For `turn`, `ratify`, `object`, `withdraw`, and `propose-close` events, the SKILL.md per-route sections give you the exact `node --input-type=module -e "..."` snippet. The shared helpers in `collab-event-helpers.mjs` handle pull-rebase, event ID generation, append, render, and commit-push.

When you're emitting a `turn`, the payload **must** include `signals` (an array, possibly empty). Don't omit it. See the event schema section below.

### Silence

You are not required to emit an event every tick. If you have nothing substantive to add, emit nothing. The stall safety net handles true abandonment (6 collective ticks of silence across all agents). After a `propose-close`, your silence for 90+ minutes counts as ratification — unless the kickoff named your review as a ratified completion measure, in which case it never does. See the termination section.

## The /collab interface

The router parses your message and inspects state to pick one of six routes:

| Message shape | State check | Route |
|---|---|---|
| Describes work; no slug referenced | No existing matching collab | **kickoff** — derive slug, write KICKOFF.md, emit kickoff + self-join, self-start /loop |
| References a slug ("look at slug X", `<slug-string>`) | Slug exists; you haven't joined | **join** — read kickoff, decide, emit join or decline |
| References a slug | Slug exists; you're joined | **tick** — read new events, decide, emit (or not), render |
| Asks for status ("what's happening with X", "status of X") | Slug exists | **status** — render to terminal; no event written |
| Says abort/cancel + names a slug | Slug exists; not closed | **abort** — emit close with `outcome: aborted-david` |
| Names a slug-shaped string | Doesn't match any known slug | **fuzzy** — ask user to disambiguate; or treat as kickoff if the message describes new work |

Don't guess on fuzzy — ask the user, or surface the issue.

## Event schema

Every event in `events.jsonl` has the same envelope plus a type-specific `payload`.

### Envelope

```json
{
  "event_id": "evt-001",
  "ts": "2026-05-25T14:32:00Z",
  "author": "core-framework@claude-code:home",
  "slug": "memory-architecture-review-pass",
  "type": "kickoff",
  "references": [],
  "payload": { /* type-specific, see below */ }
}
```

| Field | Meaning |
|---|---|
| `event_id` | Monotonic per slug. Format `evt-<NNN>` zero-padded to 3 digits; auto-widens past 999. |
| `ts` | ISO 8601 UTC. Informational — ordering is by file position + `event_id`. |
| `author` | Triplet `<workspace_id>@<harness>:<machine-slug>`. Identity unit. |
| `slug` | The collab slug (no date prefix). Matches the directory name's slug portion. |
| `type` | One of the nine event types below. |
| `references` | Array of `event_id`s this event responds to. Forms a DAG over the log. |
| `payload` | Type-specific. See per-type table. |

### Per-type payloads

| Type | Required payload fields | Who emits | When |
|---|---|---|---|
| `kickoff` | `message`, `igm`, `capabilities_wanted`, `wall_clock_hours` | Originator | Exactly once, at kickoff |
| `join` | `capability_match`, `commitment` | Joining agent | Once per agent per collab |
| `decline` | `reason` | Agent who won't join | Once per agent per collab |
| `turn` | `intent`, `body`, **`signals`** | Any joined agent | Any tick |
| `propose-close` | `synthesis`, `igm_met` | Any joined agent | Once per close cycle; objection resets |
| `ratify` | (none) — optional `agreement_notes` | Any joined agent | Response to propose-close |
| `object` | `reason` | Any joined agent | Response to propose-close; invalidates it |
| `withdraw` | (none) — optional `reason` | Any joined agent | Voluntary exit; removes from ratification math |
| `close` | `final_synthesis`, `outcome` | Originator (for `converged`); any agent (for safety-net aborts) | Terminal |

### Critical fields to get right

**`signals` is required on every `turn` event.** Even if you have no signal to raise, pass an empty array: `signals: []`. The validator rejects turn events that omit `signals`. Valid signal strings include `needs-david`, `blocked-on-external`, `confidence-low` — the list is open. (This caught two agents in cross-harness testing.)

**`body` belongs on `turn`. `synthesis` belongs on `propose-close`.** Do not put turn content in a `synthesis` field on a turn event, even if your `intent` is `synthesize`. The field name is `body`. `synthesis` is the payload field name on `propose-close` only. (This also caught an agent.)

### Enumerations

| Field | Valid values |
|---|---|
| `turn.intent` | `propose`, `critique`, `probe`, `synthesize`, `clarify` |
| `close.outcome` | `converged`, `aborted-stall`, `aborted-budget`, `aborted-objection`, `aborted-david`, `complete-to-authority-boundary`, `failed-safely` |

### IGM object shape (inside `kickoff.payload.igm`)

```yaml
igm:
  intention: "Why this matters — the underlying concern"
  goal: "Concrete artifact or decision to produce"
  measure: "How we know we're done; what would NOT satisfy"
```

`measure` is load-bearing. If the kickoff message is too vague to derive a concrete measure, kickoff writes a placeholder and any joined agent can sharpen it via a `turn` with `intent: clarify`.

## Termination

### Convergence path

1. Any joined agent emits `propose-close` with `synthesis` and per-dimension `igm_met` ({intention, goal, measure} each with `met` + `rationale`).
2. Each other joined agent has 3 of its own ticks (≈90 minutes at the 30-minute /loop cadence) to emit `ratify` or `object`.
3. **Silence as ratification:** a joined agent who has emitted no events for 90+ minutes after the `propose-close` is treated as implicitly ratified. This keeps offline peers (usage limit, machine down) from blocking convergence forever. An agent who explicitly wants to ratify or object can do so anytime; silence only kicks in after the 90-minute window.
4. **Except for a required reviewer.** A kickoff can declare that a particular participant's review is itself a ratified completion measure, with `--required-review <triplet>` (which writes `ratified_completion_measures` onto the kickoff payload). Silence from that participant never ratifies, however long it runs — their review is the measure, so silence is the missing evidence, not consent. This narrows rule 3; it does not repeal it. Everyone not named still ratifies by going quiet.
5. If all other joined agents have ratified (explicitly or implicitly), the agent that emitted `propose-close` emits `close` with `outcome: converged` and `final_synthesis`.
6. If a declared review never arrives, the proposer's tick closes as `complete-to-authority-boundary` instead: it carries the synthesis and the real ratifiers, and it names the unmet measure and the participant who owed it. There is no outcome that waives a ratified measure by calling the result degraded — the measure is discharged by a real `ratify` or `object`, or it is reported as missing. A collab that produced nothing usable, but left nothing broken, closes as `failed-safely`.
7. All agents see `close` on next tick; cancel their own `/loop`; exit.

Any `object` event invalidates the `propose-close`. The collab continues; anyone can propose-close again later. No retry cap — the objection-deadlock safety net (3 cycles) bounds it.

### Safety nets

| Net | Default | Detection | Close outcome |
|---|---|---|---|
| Wall-clock | 24h from kickoff `ts` | Each tick: `now - kickoff.ts > wall_clock_hours * 3600` | `aborted-budget` |
| Stall | 6 consecutive ticks with no new events from any participant | Each tick tracks `last_event_ts` for the slug | `aborted-stall` |
| Objection deadlock | 3 propose-close cycles, each objected to | Each tick scans event history | `aborted-objection` |
| David abort | `/collab "abort slug X"` on any agent | Direct emit | `aborted-david` |

Any agent can detect a safety-net trigger and emit `close`. The "originator emits close" rule applies to `converged` closes only — safety-net closes are distributed.

## Capability declaration

Each participating agent declares its capabilities at `<workspace>/_collab/capabilities.yaml`:

```yaml
triplet: core-framework@claude-code:home
capabilities:
  core-development: CORE plugin development, skill editing, memory architecture
  architecture-design: Protocol design, schema design, ADR authoring
  synthesis: Multi-agent output integration and ratification reasoning
```

Plain text. The vocabulary is open — extend as needed for your domain.

### Starter vocabulary

| Tag | Meaning |
|---|---|
| `architecture-design` | System architecture and protocol design |
| `code-review` | Implementation reading and critique |
| `empirical-probe` | Running tests, reporting actual behavior |
| `synthesis` | Integrating multiple perspectives into a coherent summary |
| `windows-testing` | Windows runtime validation, path-separator testing |
| `bblens-context` | BBLens overlay + T-Mobile broadband product context |
| `core-development` | CORE plugin + skill development |
| `codex-behavior` | Codex harness-specific behavior and limitations |
| `domain-research` | External tools, papers, or standards research |
| `external-source-access` | Can pull from external APIs or document stores |

See [`skills/collab/references/capabilities.md`](skills/collab/references/capabilities.md) for the canonical reference and extension guidance.

If `capabilities.yaml` is missing, an agent reasons about fit from prose alone — graceful degradation, not a blocker.

## Failure modes

| Mode | Mechanism | Recovery |
|---|---|---|
| Git push race | Pull-before-write; on reject, pull-rebase-retry up to 3 times | Self-healing within one tick cycle |
| Git merge conflict on `events.jsonl` | Append-only semantics: concatenate both sides in `ts` order, dedupe by `event_id`; renderer rebuilds STATUS.md and turns/ | Self-healing; validator catches dupes |
| Malformed event | `collab-validate.mjs` runs on every tick; flags invalid events in STATUS.md `validation-warnings`; collab continues, malformed event inert | Surfaced for human review at next status check |
| Agent crashes mid-tick | No event written, no commit, no push. Next `/loop` fire is a fresh tick | Self-healing |
| Agent's `/loop` never re-fires | Other agents see stall (no events from this triplet). Stall safety net triggers after 6 ticks | Stall net handles permanent absence; live agents wait through temporary absence |
| Files repo unreachable | Pull/push errors caught; tick logs error locally; collab continues from this agent's perspective | Catches up on next successful pull |
| Slug collision | Kickoff script checks for existing directory; appends `-2`, `-3`, etc. before writing | Mechanical at kickoff |
| Originator offline at abort time | `/collab "abort slug X"` on any agent emits `close` (`aborted-david`) | Distributed abort capability |
| Three propose-close-then-object cycles | `aborted-objection` close emitted automatically | Bounded objection deadlock |
| Missing `capabilities.yaml` | Agent reasons from prose alone | Graceful degradation |
| Renderer crash (renders corrupted but events.jsonl intact) | Next tick rebuilds renders from JSONL | Self-healing |
| Cross-machine clock skew | `ts` is informational; ordering is by file position + `event_id` | Tolerant of small skew; large skew (>1h) flagged by validator |

## File layout

### Per-collab (location depends on transport)

For `github:<repo>` transport: `~/Documents/Projects/<repo>/collabs/<YYYY-MM-DD>-<slug>/`.
For `localhost` transport: `~/.collab/local/<YYYY-MM-DD>-<slug>/`.

```
<collab-dir>/
├── KICKOFF.md            ← Initial post; written once, never modified
├── STATUS.md             ← Convergence tracker; re-rendered every tick
├── events.jsonl          ← Rendered concatenation of events/; convenience read surface
├── events/
│   ├── evt-001.json      ← One file per event (canonical, append-only)
│   ├── evt-002.json
│   └── ...
└── turns/
    ├── 001-home-keel.md  ← Per-turn human-readable renders
    ├── 002-work-keel.md
    └── ...
```

Per-event files under `events/` are canonical. `events.jsonl` and the markdown files are renders, rebuilt from `events/` on every tick. If a render gets corrupted by a git conflict or partial push, the renderer rebuilds it from the per-event files on the next tick.

### Plugin repo

```
dbatesai/collab-plugin/
├── README.md                               ← This document
├── CHANGELOG.md                            ← Keep a Changelog format
├── BUILD                                   ← Build identifier
├── .claude-plugin/
│   ├── plugin.json                         ← Claude Code manifest
│   └── marketplace.json                    ← Claude Code marketplace listing
├── .codex-plugin/plugin.json               ← Codex manifest
├── .gemini-plugin/plugin.json              ← Gemini manifest
├── skills/collab/
│   ├── SKILL.md                            ← Agent operating manual; per-route algorithms
│   ├── scripts/
│   │   ├── collab-route.mjs                ← Deterministic message + state routing
│   │   ├── collab-kickoff.mjs              ← Slug derivation, IGM scaffolding, kickoff write
│   │   ├── collab-tick.mjs                 ← Pull, check safety nets, advance state, surface decision
│   │   ├── collab-render.mjs               ← STATUS.md + turns/*.md from events.jsonl
│   │   ├── collab-status.mjs               ← Terminal status display
│   │   ├── collab-validate.mjs             ← Schema check on events.jsonl
│   │   └── collab-event-helpers.mjs        ← Shared: event I/O, triplet, slug, git transport
│   └── references/
│       ├── capabilities.md                 ← Starter capability vocabulary
│       └── igm-derivation.md               ← IGM inference template
└── tests/                                  ← Unit + SKILL.md prose tests
```

### Per-agent workspace

```
<workspace>/_collab/
└── capabilities.yaml                       ← This agent's capability declaration
```

## Worked example

Slug: `architecture-review-pass`. Three agents: Home-Keel (originator, Claude Code), Work-Keel (Claude Code on a second Mac), Codex (third harness on the originator's machine).

**evt-001 — kickoff (Home-Keel).** David runs `/collab "architecture review pass — does the current memory architecture meet IGM after Phase 1b? Need critique from BBLens lens + Codex behavior probe."` Home-Keel derives slug `architecture-review-pass`, IGM (intention: validate architecture; goal: explicit go/no-go on IGM compliance; measure: per-IGM-dimension boolean + rationale OR a specific change list), `capabilities_wanted: [bblens-context, codex-behavior, architecture-design]`. Writes `KICKOFF.md`, emits `kickoff`, emits `evt-002` `join` (self-join), starts `/loop 30m`.

**evt-003 — join (Work-Keel).** David walks to Work-Keel: *"Look at slug architecture-review-pass."* Work-Keel pulls, reads kickoff, capability-matches `bblens-context`, emits `join` with `capability_match: [bblens-context]`, `commitment: "Evaluate against BBLens Phase 1b usage patterns."` Starts its own `/loop`.

**evt-004 — join (Codex).** Same instruction at Codex. Emits `join` with `capability_match: [codex-behavior]`, `commitment: "Probe actual Codex behavior; surface anything the design misses."` Starts its own `/loop`.

**evt-005 — turn / propose (Home-Keel).** Tick fires. Home-Keel reads recent events, emits a `turn` with `intent: propose`, `body: "<architecture-as-built summary>"`, `signals: []`.

**evt-006 — turn / critique (Work-Keel).** Reads evt-005, emits `turn` with `intent: critique`, `body: "<specific BBLens friction>"`, `signals: ["confidence-low"]`, `references: ["evt-005"]`.

**evt-007 — turn / probe (Codex).** Reports actual Codex behavior. `intent: probe`, `body: "..."`, `signals: []`.

**evt-008 — turn / synthesize (Home-Keel).** Reads everything, integrates. `intent: synthesize`, `body: "<integrated view>"`, `signals: []`.

**evt-009 — propose-close (Home-Keel).** IGM looks met. `synthesis: "<markdown>"`, `igm_met: {intention: {met: true, rationale: "..."}, goal: {met: true, rationale: "..."}, measure: {met: true, rationale: "Both critiques addressed; change list documented."}}`.

**evt-010 — ratify (Work-Keel).** Reads synthesis against IGM. Genuinely addresses each dimension. Emits `ratify` with `agreement_notes: "Synthesis captures the BBLens-side concerns."`

**evt-011 — ratify (Codex).** Same.

**evt-012 — close (Home-Keel).** Sees all ratifications. Emits `close` with `outcome: converged`, `final_synthesis: "..."`. STATUS.md updates to CLOSED.

**All agents.** Next tick sees `close`, cancels own `/loop`, exits.

**Result.** Real artifact at `~/Documents/Projects/files/collabs/2026-05-25-architecture-review-pass/`. Fully reproducible from `events.jsonl`. Two David touches (kickoff + two "look here" instructions). Three agents converging autonomously. About 6 hours wall clock at 30-minute cadence.

## Known limitations (v0.1)

These two limitations were surfaced during v0.1 cross-harness validation and are scheduled for v0.2.

- **No supersede or errata semantics for malformed events.** Once a malformed event lands in `events.jsonl`, the validator will always flag it, even if the author re-emits a corrected version immediately after. Append-only semantics + per-event-id uniqueness mean both events live in the log forever. v0.2 will add either explicit `supersedes` envelope semantics or an `errata` event type so corrected re-emits can produce validator-passing logs. Until then, treat the first emit as load-bearing — slow down and get the payload right before appending.

- **IGM refinement via `clarify` turn doesn't propagate to STATUS.md.** `STATUS.md` renders the kickoff event's IGM verbatim. If a `turn` with `intent: clarify` refines the IGM mid-collab, that refinement lives in `events.jsonl` but isn't visible in the rendered status — readers checking STATUS.md will see the original IGM, not the refined one. v0.2 will either teach the renderer to surface clarified IGM versions or make explicit that kickoff IGM is canonical and clarifications are advisory annotations.

## See also

- [`skills/collab/SKILL.md`](skills/collab/SKILL.md) — agent operating manual with per-route algorithms and exact script invocations.
- [`skills/collab/references/capabilities.md`](skills/collab/references/capabilities.md) — capability vocabulary and extension guidance.
- [`skills/collab/references/igm-derivation.md`](skills/collab/references/igm-derivation.md) — IGM inference template for kickoff agents.
- [`CHANGELOG.md`](CHANGELOG.md) — release history.
