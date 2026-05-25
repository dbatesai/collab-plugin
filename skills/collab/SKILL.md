---
name: collab
description: "Autonomous multi-agent collaboration. Single /collab <message> command routes by message + state into five paths — kickoff, join, tick, status, abort. Structured JSONL events on two transports — localhost (~/.collab/local/) for same-machine; github:<repo> for cross-machine. Cross-machine + cross-harness. Requires core-plugin."
---

# collab

## What this skill does

When a user types `/collab <message>`, route the message + state to one of five actions: **kickoff**, **join**, **tick**, **status**, or **abort**. All collab state lives in `<collab-dir>/events/` (canonical, one event per file) with rendered `STATUS.md`, `events.jsonl`, and `turns/*.md` files. The `<collab-dir>` location depends on transport: `~/Documents/Projects/<repo>/collabs/<YYYY-MM-DD>-<slug>/` for `github:<repo>`, `~/.collab/local/<YYYY-MM-DD>-<slug>/` for `localhost`. See "Choosing a transport" below.

**Path variable:** Script examples below use `${COLLAB_PLUGIN_ROOT}`. Substitute the actual path for your harness: `${COLLAB_PLUGIN_ROOT}` on Claude Code, `${CODEX_PLUGIN_ROOT}` on Codex, `${GEMINI_PLUGIN_ROOT}` on Gemini CLI.

The agent (you, Claude Code) makes judgment calls about turn content and ratify/object decisions. The scripts handle everything mechanical: event schema, slug derivation, safety-net checks, git transport.

## Step 1: Detect the route

Run the deterministic routing script:

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-route.mjs "<message>" --workspace-id <workspace_id>
```

Output is JSON: `{ route, slug?, extractedSlug?, transport, triplet }`.

The route script extracts a leading transport token (`localhost` or `github:<repo>`) from the message before slug derivation. The result JSON now includes a `transport` field. If David's command includes the transport prefix (`/collab localhost discuss xyz`), the route returns that transport. If omitted, the default is `github:files` — preserves v0.1.x behavior.

- `route: "kickoff"` — no slug referenced, message describes new work
- `route: "join"` — message references a known active slug; agent hasn't joined yet
- `route: "tick"` — message references a known active slug; agent is joined
- `route: "status"` — message asks about a known slug
- `route: "abort"` — message says abort/cancel + names a known active slug
- `route: "fuzzy"` — message references a slug-shaped string that doesn't match. Ask the user for disambiguation, or treat as kickoff if appropriate.

**PINs (David's manual-entry shorthand).** A kickoff event stores a 6-digit `pin` in its payload so David can refer to a collab by `/collab 654321` instead of typing the full slug. The route script resolves a bare 6-digit number to the corresponding full slug before action detection. **Agents always communicate by slug** — in event payloads, in messages to peers, in status reports. The PIN exists solely so David can start an agent on a topic with minimal typing; the slug is the canonical identifier from that point on.

## Choosing a transport

| Situation | Use |
|---|---|
| All participants on the same machine (same Mac) | `localhost` |
| Any participant on a different machine | `github:<repo>` (typically `github:files`) |
| Cross-harness on the same machine (HK + Gemini + Codex on this M5) | `localhost` |
| Cross-machine collab (HK on M5 + WK on M4) | `github:files` |

Localhost runs at faster cadence (default 2 minutes) because there's no git round-trip. Use `--tick-interval-minutes 1` on kickoff for high-stakes adversarial review where objections need to land within a minute.

The transport is set at kickoff and cannot change for the lifetime of the collab. If any participant is remote, choose `github:<repo>` at kickoff — a `localhost` collab cannot accept remote joins.

David might type either form of any route — with the transport prefix or without. The route script accepts both:

```
/collab discuss the architecture                    # kickoff, defaults to github:files
/collab localhost discuss the architecture          # kickoff, localhost

/collab look at slug memory-arch                    # join (or tick), auto-resolves transport from disk
/collab localhost look at slug memory-arch          # join (or tick), explicit transport

/collab status of slug memory-arch                  # status, auto-resolves
/collab github:files status of slug memory-arch     # status, explicit

/collab abort slug memory-arch                      # abort, auto-resolves
/collab localhost abort slug memory-arch            # abort, explicit
```

The prefix only matters at kickoff. On join, tick, status, and abort, the route script resolves the transport from disk by finding the slug across all known transports — so the prefix is informational and can be omitted.

## Step 2: Execute the route

### Route: kickoff

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-kickoff.mjs "<message>" --workspace-id <id> [--transport <localhost|github:<repo>>] [--tick-interval-minutes <n>] [--pin <6-digits>] [--ratification-window-minutes <n>] [--min-version <semver>]
```

This writes `KICKOFF.md`, an `evt-001` kickoff event with placeholder IGM, an `evt-002` self-join event, commits (on git transports), and pushes. Stdout reports the slug, the auto-generated 6-digit PIN (David's manual-entry shorthand), the transport, and the recommended `/loop` command at the chosen cadence.

Pass the route's `transport` field through as `--transport`. If David's message had no transport prefix, the route returns `github:files` (v0.1.x behavior) — pass that through.

`--pin <6-digits>` (optional) lets the caller supply a specific PIN instead of generating one randomly; useful for testing or when David has a preferred number to remember.

`--tick-interval-minutes <n>` (optional) sets the per-collab tick cadence. Default is 30 for `github:<repo>` and 2 for `localhost`. Two safety nets scale with it: the stall threshold (6 × tick) and the silence-as-ratification window (3 × tick). Valid range: 1–1440.

`--ratification-window-minutes <n>` (optional) decouples the silence-as-ratification window from the tick cadence. Default is `3 × tick` for git transports and `max(3 × tick, 30)` for localhost — the 30-minute floor on localhost prevents a 1-minute tick from collapsing the ratification window to 3 minutes.

`--min-version <semver>` (optional; default `0.2.0`) sets the minimum collab-plugin version a joining agent must run. Any v0.2 agent joins fine; older agents are rejected at the join check. Bump above `0.2.0` only when a kickoff relies on a feature shipped in a later patch.

**If the placeholder IGM is too vague**, edit `events.jsonl` to refine the kickoff event's `igm.measure` field before the next tick — but only the originator should refine, and only before any other agent has joined. After that, refine via a `turn` event with intent `clarify`.

Then start the loop so the collab runs autonomously, using the cadence printed by the kickoff script (e.g., `/loop 5m /collab "look at slug <slug>"` if you passed `--tick-interval-minutes 5`):

```
/loop <n>m /collab "look at slug <slug>"
```

Tell the user: "Kicked off slug `<slug>`. To bring other agents in, tell them: *look at slug `<slug>` in the files repo.*" For a localhost collab, instruct the other agents to run `/collab localhost look at slug <slug>` — the transport prefix is needed because there's no files repo for them to scan.

### Route: join

You already have the slug from the route output. Now decide:

1. Read the collab directory: `~/Documents/Projects/files/collabs/<YYYY-MM-DD>-<slug>/KICKOFF.md` for git transports, or `~/.collab/local/<YYYY-MM-DD>-<slug>/KICKOFF.md` for localhost. The `transport` field in the route output tells you which.
2. Read your capabilities: `<workspace>/_collab/capabilities.yaml`
3. Compare `capabilities_wanted` (from kickoff event) against your capabilities. Treat as a hint, not a gate.
4. Reason about fit: *"Do I have something useful to add, or would I just be agreeing?"*

If yes — emit a join event by running:

```bash
node --input-type=module -e "
import {findCollabDir, readEvents, nextEventId, appendEvent, deriveTriplet, gitPullRebase, gitCommitPush} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
gitPullRebase();
const dir = findCollabDir('<slug>');
const events = readEvents(dir);
const triplet = deriveTriplet('<workspace_id>');
const ev = { event_id: nextEventId(events), ts: new Date().toISOString(), author: triplet, slug: '<slug>',
  type: 'join', references: ['evt-001'],
  payload: { capability_match: ['<your-matched-tags>'], commitment: '<one-line-commitment>' } };
appendEvent(dir, ev);
await render('<slug>', { collabDir: dir, author: triplet });
"
```

Then start the loop using the kickoff's cadence — the route script's output includes `tick_interval_minutes` (defaulting to 30 if the kickoff didn't declare one): `/loop <n>m /collab "look at slug <slug>"`.

If no — emit a `decline` event with reason instead (same pattern, `type: 'decline'`, `payload: { reason: '...' }`). Don't start the loop.

### Route: tick

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-tick.mjs <slug> --workspace-id <id>
```

This runs the deterministic part of the tick (pull, check safety nets, handle close paths). Stdout returns JSON:

- `{ action: "exit", reason: "closed" }` — cancel `/loop` and exit. The collab is done.
- `{ action: "close", reason: "<safety-net-or-converged>" }` — tick handled it; the close event was emitted. Cancel `/loop` and exit.
- `{ action: "agent-decision-needed", route: "ratify-or-object" }` — see "Ratify or object" below.
- `{ action: "agent-decision-needed", route: "turn-or-propose" }` — see "Turn or propose-close" below.
- `{ action: "not-joined" }` — bug or weird state; ask the user.

#### Ratify or object

Another agent proposed close. You have 3 of your own ticks to decide (≈90 minutes at the standard 30-min /loop cadence). If you stay silent for that window — emit no events at all — you'll be treated as having implicitly ratified. This is intentional: peers who go offline (usage limit, machine down, network issue) shouldn't block convergence forever. If you actively want to ratify or object, emit the event; otherwise your silence speaks for you.

1. Read the propose-close event (the last `type: propose-close` in events.jsonl with no following object/close).
2. Read its `synthesis` and `igm_met` against the kickoff's IGM.
3. Decide: does the synthesis genuinely address each IGM dimension? If yes → emit `ratify`. If no → emit `object` with a specific reason.

Use the same `node --input-type=module -e "..."` pattern as join, with `type: 'ratify'` and `payload: { agreement_notes: '<optional>' }` OR `type: 'object'` and `payload: { reason: '<what-is-missing>' }`. Set `references: ['<propose-close-event-id>']`.

Bias toward objecting if anything is genuinely missing — the spec's `risk-9-bad-infrastructure-convergence` mitigation depends on first-class objections. Don't ratify out of agreeableness.

#### Turn or propose-close

The collab is mid-discussion. You have new context to add — or you don't.

1. Read recent events (last 5-10). Read your own past turns. Understand where the discussion is.
2. Decide what to emit:
   - `turn` with `intent: propose` — you're making a substantive claim
   - `turn` with `intent: critique` — you're challenging another agent's claim
   - `turn` with `intent: probe` — you're surfacing an empirical question
   - `turn` with `intent: synthesize` — you're integrating others' inputs
   - `turn` with `intent: clarify` — you're refining the IGM or a prior turn's ambiguity
   - `propose-close` — IGM is met; here's the synthesis
   - Nothing — if there's no new content to add, emit no event. The stall safety net handles true abandonment (6×30min collective silence).

A `turn` payload looks like:

```
payload: {
  intent: 'propose',   // or critique | probe | synthesize | clarify
  body: '<your turn content as markdown>',
  signals: []          // REQUIRED — empty array if none; e.g. ['needs-david', 'blocked-on-external', 'confidence-low']
}
```

The `body` field is for `turn` events. Do not put turn content under `synthesis` — `synthesis` is the field name on `propose-close` payloads only. Conflating them will fail validation. `signals` is required even when empty; pass `[]`.

For `propose-close`, the synthesis MUST address each IGM dimension explicitly:

```
payload: {
  synthesis: "<markdown summary>",
  igm_met: {
    intention: { met: true|false, rationale: "..." },
    goal:      { met: true|false, rationale: "..." },
    measure:   { met: true|false, rationale: "..." }
  }
}
```

If any dimension is `met: false`, your synthesis must name what's still required. The objection safety net (3 cycles) bounds runaway propose-then-object.

### Route: status

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-status.mjs <slug>
```

Pure terminal display. No event emitted.

### Route: abort

Emit a close event with `outcome: 'aborted-david'`:

```bash
node --input-type=module -e "
import {findCollabDir, readEvents, nextEventId, appendEvent, deriveTriplet, gitPullRebase, gitCommitPush} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
gitPullRebase();
const dir = findCollabDir('<slug>');
const events = readEvents(dir);
const triplet = deriveTriplet('<workspace_id>');
const ev = { event_id: nextEventId(events), ts: new Date().toISOString(), author: triplet, slug: '<slug>',
  type: 'close', references: [], payload: { final_synthesis: 'David requested abort', outcome: 'aborted-david' } };
appendEvent(dir, ev);
await render('<slug>', { collabDir: dir, author: triplet });
"
```

Cancel `/loop` after the abort event lands. Other agents will see `close` on their next tick and exit too.

### Route: fuzzy

The message named a slug-shaped string that doesn't match any known collab. Either:
- Ask the user to clarify which slug they mean
- Or, if the message describes new work, treat as kickoff
- Or, if obviously a typo or stale reference, surface the issue and propose options

Don't guess silently.

## References

- `references/capabilities.md` — starter capability vocabulary
- `references/igm-derivation.md` — IGM inference template

## Architecture invariants

- Per-event files under `events/` are canonical; `events.jsonl` and markdown files are renders (rebuilt from `events/` on next tick)
- Transport is set at kickoff and immutable for the collab's lifetime. `localhost` keeps state at `~/.collab/local/`; `github:<repo>` at `~/Documents/Projects/<repo>/collabs/`. Slugs are unique across all transports.
- Agents only emit events when they have something to say — no heartbeat events
- Three safety nets bound runaway: wall-clock (24h default), stall (6 × tick cadence collective silence), objection-deadlock (3 propose-object cycles)
- **Safety nets scale with the kickoff's `tick_interval_minutes`** (default 30 on git, 2 on localhost): a 5-min-cadence collab stalls at 30 min of silence and treats 15 min of post-propose-close silence as implicit ratification; a 30-min-cadence collab stalls at 3 hours and ratifies silence at 90 min. The kickoff event is the source of truth; safety-net thresholds are computed from it per tick. `ratification_window_minutes` can be set independently on kickoff; localhost has a 30-min floor.
- `close` event `outcome` is one of: `converged` (ratification completed), `aborted-stall`, `aborted-budget` (wall-clock exceeded), `aborted-objection` (deadlock), `aborted-david` (user requested abort)
- Single-agent collabs converge immediately on `propose-close` (no ratification needed)
- **Silence-as-ratification:** a joined agent who emits no events for the ratification window after a propose-close is treated as implicitly ratifying. Explicit ratify/object events override silence. This handles offline peers (usage limits, crashes) without stalling convergence.
