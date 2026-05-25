---
name: collab
description: Autonomous multi-agent collaboration. Single /collab <message> command routes by message + state into five paths: kickoff, join, tick, status, abort. Structured JSONL events on git transport at ~/Documents/Projects/files/collabs/. Cross-machine + cross-harness. Requires core-plugin.
---

# collab

## What this skill does

When a user types `/collab <message>`, route the message + state to one of five actions: **kickoff**, **join**, **tick**, **status**, or **abort**. All collab state lives in `~/Documents/Projects/files/collabs/<YYYY-MM-DD>-<slug>/events.jsonl` (canonical) with rendered `STATUS.md` and `turns/*.md` files.

The agent (you, Claude Code) makes judgment calls about turn content and ratify/object decisions. The scripts handle everything mechanical: event schema, slug derivation, safety-net checks, git transport.

## Step 1: Detect the route

Run the deterministic routing script:

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-route.mjs "<message>" --workspace-id <workspace_id>
```

Output is JSON: `{ route, slug?, extractedSlug?, triplet }`.

- `route: "kickoff"` — no slug referenced, message describes new work
- `route: "join"` — message references a known active slug; agent hasn't joined yet
- `route: "tick"` — message references a known active slug; agent is joined
- `route: "status"` — message asks about a known slug
- `route: "abort"` — message says abort/cancel + names a known active slug
- `route: "fuzzy"` — message references a slug-shaped string that doesn't match. Ask the user for disambiguation, or treat as kickoff if appropriate.

## Step 2: Execute the route

### Route: kickoff

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-kickoff.mjs "<message>" --workspace-id <id>
```

This writes `KICKOFF.md`, an `evt-001` kickoff event with placeholder IGM, an `evt-002` self-join event, commits, and pushes. Stdout reports the slug.

**If the placeholder IGM is too vague**, edit `events.jsonl` to refine the kickoff event's `igm.measure` field before the next tick — but only the originator should refine, and only before any other agent has joined. After that, refine via a `turn` event with intent `clarify`.

Then start the loop so the collab runs autonomously:

```
/loop 30m /collab "look at slug <slug>"
```

Tell the user: "Kicked off slug `<slug>`. To bring other agents in, tell them: *look at slug `<slug>` in the files repo.*"

### Route: join

You already have the slug from the route output. Now decide:

1. Read the collab directory: `~/Documents/Projects/files/collabs/<YYYY-MM-DD>-<slug>/KICKOFF.md`
2. Read your capabilities: `<workspace>/_collab/capabilities.yaml`
3. Compare `capabilities_wanted` (from kickoff event) against your capabilities. Treat as a hint, not a gate.
4. Reason about fit: *"Do I have something useful to add, or would I just be agreeing?"*

If yes — emit a join event by running:

```bash
node --input-type=module -e "
import {findCollabDir, readEvents, nextEventId, appendEvent, deriveTriplet, gitPullRebase, gitCommitPush} from '${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
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

Then start the loop: `/loop 30m /collab "look at slug <slug>"`.

If no — emit a `decline` event with reason instead (same pattern, `type: 'decline'`, `payload: { reason: '...' }`). Don't start the loop.

### Route: tick

```bash
node ${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-tick.mjs <slug> --workspace-id <id>
```

This runs the deterministic part of the tick (pull, check safety nets, handle close paths). Stdout returns JSON:

- `{ action: "exit", reason: "closed" }` — cancel `/loop` and exit. The collab is done.
- `{ action: "close", reason: "<safety-net-or-converged>" }` — tick handled it; the close event was emitted. Cancel `/loop` and exit.
- `{ action: "agent-decision-needed", route: "ratify-or-object" }` — see "Ratify or object" below.
- `{ action: "agent-decision-needed", route: "turn-or-propose" }` — see "Turn or propose-close" below.
- `{ action: "not-joined" }` — bug or weird state; ask the user.

#### Ratify or object

Another agent proposed close. You have 3 of your own ticks to decide.

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
node ${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-status.mjs <slug>
```

Pure terminal display. No event emitted.

### Route: abort

Emit a close event with `outcome: 'aborted-david'`:

```bash
node --input-type=module -e "
import {findCollabDir, readEvents, nextEventId, appendEvent, deriveTriplet, gitPullRebase, gitCommitPush} from '${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${CLAUDE_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
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

- `events.jsonl` is canonical; markdown files are renders (rebuilt from JSONL on next tick)
- Agents only emit events when they have something to say — no heartbeat events
- Three safety nets bound runaway: wall-clock (24h default), stall (6×30min collective silence), objection-deadlock (3 propose-object cycles)
- Single-agent collabs converge immediately on `propose-close` (no ratification needed)
