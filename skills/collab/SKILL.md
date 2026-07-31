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

The route script extracts a leading transport token (`localhost` or `github:<repo>`) from the message before slug derivation. The result carries `transport` plus a `transportBasis` saying where it came from — `explicit` when the message named it, `resolved` when it was found on disk from the slug.

**A kickoff with no transport is refused, not defaulted.** The route returns `transport-required` with `transport: null`; ask which one before starting. Guessing is not a small mistake here — it can put a same-machine collab on a git repo, or strand a cross-machine collab on a filesystem the other agent cannot see, and the ledger would record the value without recording that nobody chose it.

Every other route — join, tick, status, abort — still needs no prefix, because it finds the slug on disk and reads the transport from there.

- `route: "kickoff"` — no slug referenced, message describes new work
- `route: "join"` — message references a known active slug; agent hasn't joined yet
- `route: "tick"` — message references a known active slug; agent is joined
- `route: "status"` — message asks about a known slug
- `route: "abort"` — message says abort/cancel + names a known active slug
- `route: "fuzzy"` — message references a slug-shaped string that doesn't match. Ask the user for disambiguation. **Never** convert an unresolved explicit slug or PIN into a kickoff: that silently forks a second parallel channel and both sides then wait forever for peers who are in the other one.

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
/collab discuss the architecture                    # REFUSED — a kickoff will not guess a transport
/collab localhost discuss the architecture          # kickoff on this machine
/collab github:files discuss the architecture       # kickoff across machines

/collab look at slug memory-arch                    # join (or tick), auto-resolves transport from disk
/collab localhost look at slug memory-arch          # join (or tick), explicit transport

/collab status of slug memory-arch                  # status, auto-resolves
/collab github:files status of slug memory-arch     # status, explicit

/collab abort slug memory-arch                      # abort, auto-resolves
/collab localhost abort slug memory-arch            # abort, explicit
```

The prefix is required at kickoff and optional everywhere else. On join, tick, status, and abort the route script resolves the transport from disk by finding the slug across all known transports, so the prefix is informational there and can be omitted.

## Step 2: Execute the route

### Route: kickoff

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-kickoff.mjs "<message>" --workspace-id <id> [--transport <localhost|github:<repo>>] [--tick-interval-minutes <n>] [--pin <6-digits>] [--ratification-window-minutes <n>] [--min-version <semver>]
```

This writes `KICKOFF.md`, an `evt-001` kickoff event with placeholder IGM, an `evt-002` self-join event, commits (on git transports), and pushes. Stdout reports the slug, the auto-generated 6-digit PIN (David's manual-entry shorthand), the transport, and the recommended `/loop` command at the chosen cadence.

Pass the route's `transport` field through as `--transport`. A kickoff always has one, because a message with no transport prefix never reaches this route — it is refused as `transport-required` first.

`--pin <6-digits>` (optional) lets the caller supply a specific PIN instead of generating one randomly; useful for testing or when David has a preferred number to remember.

`--tick-interval-minutes <n>` (optional) sets the per-collab tick cadence. Default is 30 for `github:<repo>` and 2 for `localhost`. Two safety nets scale with it: the stall threshold (6 × tick) and the silence-as-ratification window (3 × tick). Valid range: 1–1440.

`--ratification-window-minutes <n>` (optional) decouples the silence-as-ratification window from the tick cadence. Default is `3 × tick` for git transports and `max(3 × tick, 30)` for localhost — the 30-minute floor on localhost prevents a 1-minute tick from collapsing the ratification window to 3 minutes.

`--required-review <participant-triplet>` (optional; repeatable) declares that participant's review to be a ratified completion measure. It writes `ratified_completion_measures` onto the kickoff payload, and it changes one thing at tick time: silence from that participant never ratifies. Everyone else still ratifies by going quiet. Use it when a named review is the thing that makes the outcome real — a goal that closes without it has not met its own measure, and no amount of elapsed time makes that untrue.

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
import {findCollabDir, readEvents, generateEventId, authorSlugFromTriplet, appendEvent, deriveTriplet, gitPullRebase, gitCommitPush} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
gitPullRebase('<transport>');   // e.g. 'github:files' — required; omitting it throws
const dir = findCollabDir('<slug>');
const events = readEvents(dir);
const triplet = deriveTriplet('<workspace_id>');
const ev = { event_id: generateEventId(new Date().toISOString(), authorSlugFromTriplet(triplet)), ts: new Date().toISOString(), author: triplet, slug: '<slug>',
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

Another agent proposed close. You have 3 of your own ticks to decide (≈90 minutes at the standard 30-min /loop cadence). If you stay silent for that window — emit no events at all — you'll be treated as having implicitly ratified. This is intentional: peers who go offline (usage limit, machine down, network issue) shouldn't block convergence forever.

**Unless your own review is a ratified completion measure.** If the kickoff named you in `ratified_completion_measures`, your silence never ratifies, however long it runs. There the review *is* the measure, so silence is the missing evidence rather than consent to close without it — reading it as an accept would manufacture the very verdict the measure exists to require. Emit `ratify` or `object`; nothing else discharges it. Check the propose-close status block in `STATUS.md`: it lists who is pending under silence-ratifies and who is owed a review that silence cannot cover.

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
import {findCollabDir, readEvents, generateEventId, authorSlugFromTriplet, appendEvent, deriveTriplet, gitPullRebase, gitCommitPush} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
gitPullRebase('<transport>');   // e.g. 'github:files' — required; omitting it throws
const dir = findCollabDir('<slug>');
const events = readEvents(dir);
const triplet = deriveTriplet('<workspace_id>');
const ev = { event_id: generateEventId(new Date().toISOString(), authorSlugFromTriplet(triplet)), ts: new Date().toISOString(), author: triplet, slug: '<slug>',
  type: 'close', references: [], payload: { final_synthesis: 'David requested abort', outcome: 'aborted-david' } };
appendEvent(dir, ev);
await render('<slug>', { collabDir: dir, author: triplet });
"
```

Cancel `/loop` after the abort event lands. Other agents will see `close` on their next tick and exit too.

Use `outcome: 'failed-safely'` in place of `aborted-david` when you are ending the collab yourself and the goal did not complete — nothing was produced that anyone can rely on, but nothing was left broken, half-written, or silently lost either. Say in `final_synthesis` what was preserved and what was abandoned. It is the honest word for an ending that reached no result, and it is never a synonym for `converged`.

### Route: fuzzy

The message named a slug-shaped string that doesn't match any known collab. Either:
- Ask the user to clarify which slug they mean
- Or, if obviously a typo or stale reference, surface the issue and propose options
- Only when the message carries **no explicit reference** at all and describes new work, treat as kickoff

**An unresolved explicit slug or PIN is terminal for routing — never a kickoff.** Converting
one into a new channel forks the collaboration silently: two channels, each waiting for
peers who joined the other. Report the failure with candidate matches and a repair action
instead. (This is why a symlinked transport root was so damaging — it made every channel in
that repo unresolvable, and the documented recovery was to create a new one.)

Don't guess silently.

---

## v1.0 Loop Protocol

The v1.0 loop replaces the manual `/collab "look at slug X"` pattern with a managed loop command. If you're participating in a v1.0 collab (schema_version: '1.0' events), use this instead.

### Starting and running the loop

```bash
# Start the loop (runs preflight, writes cursor state, delegates to tick)
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-loop.mjs start <slug> --workspace-id <id>

# See current status, cadence, and who owes what
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-loop.mjs status <slug> --workspace-id <id>

# Save cursor and exit (does NOT close the collab)
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-loop.mjs stop <slug> --workspace-id <id>
```

`start` returns JSON with `action: "loop-started"`, a `tick_result` (the routing decision from the existing tick path), `recommended_sleep_ms`, and the current per-participant `obligations`. Use `recommended_sleep_ms` to set your next re-entry interval — the cadence ladder starts fast (30s) and backs off to 5 minutes when nothing is happening.

Re-enter by calling `start` again. The command does NOT block-sleep; your harness drives the cadence. On Claude Code, `ScheduleWakeup` or `/loop` at the recommended interval works. On Codex, supervised re-entry at the same interval.

### The next_update_by contract

Every `turn` event you emit MUST include `next_update_by` as a **machine-parseable ISO 8601 UTC timestamp** in the payload schema field:

```json
{
  "payload": {
    "next_update_by": "2026-05-29T06:00:00Z",
    "next_update_by_local": "2026-05-29 2:00:00 AM EDT"
  }
}
```

- `next_update_by` is the schema field — **always ISO 8601** (`YYYY-MM-DDTHH:MM:SSZ`). Never a human-readable string. The chase logic, drift tracking, and obligation displays all parse this field; a human string silently breaks them.
- `next_update_by_local` (optional) carries the human-readable version for display in event bodies. Use your system's 12-hour local time with timezone abbreviation.
- If you have no firm commitment, use an empty string (`""`) — that's valid and means "no declared deadline."

Set a realistic deadline. Setting it far in the future to avoid chases defeats the accountability mechanism. A 20–30 minute window for plan work, 5 minutes for quick factual replies.

### What counts as a substantive turn vs a heartbeat

**Heartbeats are prohibited.** Do not emit a turn event just to say "I'm still here" or "working on it" with no content. The loop's fast-poll window keeps both sides checking frequently — a heartbeat wastes an event slot and pollutes the obligation tracking.

**Substantive** means the body contributes something: a decision, a critique, a question, a plan fragment, a finding, a revised spec, a test result. If you genuinely have nothing new, emit nothing — the stall safety net handles real silence. If you're actively working but not ready to post results yet, extend your `next_update_by` in a single-sentence update event.

**Signs your turn might be a heartbeat:**
- Body under 20 words
- No code, plan text, decision, or finding
- Pure status report: "Still working on X" (if that's all you have to say, wait)

### Chase events

If you miss your `next_update_by` plus a 5-minute grace period, the other side's tick automatically emits a `chase` event with `signals: ["chase", "obligation-missed", "<your-triplet>"]`. When you see one of these:

1. You owe a substantive turn — emit one immediately
2. Set a new `next_update_by` in your response
3. The chase will stop when you post something

The flood limit is 3 chase events per participant per 60-minute window, so prolonged silence will stop generating chases after 3 — but that doesn't mean the obligation has been forgotten.

### v1.0 typed payload (for v1 emitters)

If you're emitting v1 events (`schema_version: '1.0'`), turn payloads require these fields:

```json
{
  "schema_version": "1.0",
  "intent": "propose|critique|probe|synthesize|clarify",
  "state": "working|blocked|verifying|done",
  "owner": "<triplet-of-next-action-owner>",
  "waiting_on": "<triplet-or-null>",
  "next_update_by": "2026-05-29T06:00:00Z",
  "provenance": {
    "emit_mode": "interactive|supervised|automated",
    "harness": "claude-code|codex|gemini"
  },
  "body": "...",
  "signals": []
}
```

Missing any of `state`, `owner`, `waiting_on`, or `next_update_by` causes the event to be quarantined before routing — it won't be seen by the other side until you post a valid replacement. Legacy v0.2 events (no `schema_version`) still route but receive a warning.

`state` values mean what they say: `working` = you're actively on it, `blocked` = waiting on something, `verifying` = reviewing/testing, `done` = your contribution to this topic is complete.

`owner` names who should act next. If you're posing a question that needs a response from HC, set `owner: <hc-triplet>`. If you're waiting on yourself, set `owner: <your-triplet>`.

---

## References

- `references/capabilities.md` — starter capability vocabulary
- `references/igm-derivation.md` — IGM inference template

## Architecture invariants

- Per-event files under `events/` are canonical; `events.jsonl` and markdown files are renders (rebuilt from `events/` on next tick)
- Transport is set at kickoff and immutable for the collab's lifetime. `localhost` keeps state at `~/.collab/local/`; `github:<repo>` at `~/Documents/Projects/<repo>/collabs/`. Slugs are unique across all transports.
- Agents only emit events when they have something to say — no heartbeat events. See "v1.0 Loop Protocol §What counts as a substantive turn" for the concrete test.
- Three safety nets bound runaway: wall-clock (24h default), stall (6 × tick cadence collective silence), objection-deadlock (3 propose-object cycles)
- **Safety nets scale with the kickoff's `tick_interval_minutes`** (default 30 on git, 2 on localhost): a 5-min-cadence collab stalls at 30 min of silence and treats 15 min of post-propose-close silence as implicit ratification; a 30-min-cadence collab stalls at 3 hours and ratifies silence at 90 min. The kickoff event is the source of truth; safety-net thresholds are computed from it per tick. `ratification_window_minutes` can be set independently on kickoff; localhost has a 30-min floor.
- `close` event `outcome` is one of: `converged` (ratification completed), `aborted-stall`, `aborted-budget` (wall-clock exceeded), `aborted-objection` (deadlock), `aborted-david` (user requested abort), `complete-to-authority-boundary` (work landed and is preserved, but a ratified completion measure has no review attached — emitted automatically by the tick), `failed-safely` (the goal did not complete, and nothing was left broken, half-written, or silently lost)
- Single-agent collabs converge immediately on `propose-close` (no ratification needed)
- **Silence-as-ratification:** a joined agent who emits no events for the ratification window after a propose-close is treated as implicitly ratifying. Explicit ratify/object events override silence. This handles offline peers (usage limits, crashes) without stalling convergence.
- **Silence-as-ratification stops at a ratified completion measure.** A kickoff may declare `ratified_completion_measures: [{ id, description, requires_review_from }]`. Silence from a named reviewer never ratifies. When the proposer ticks with such a review still missing, the tick closes as `complete-to-authority-boundary` rather than `converged`, naming the unmet measure and the participant it was owed by, and counting only real ratifiers. This is a narrowing of the rule above, not a repeal: every participant not named still ratifies by going quiet.
- **A missing ratified review cannot be waived by degrading the result.** There is no outcome that closes a goal as done-with-caveats over a measure that has no evidence receipt. The measure is either discharged by a real `ratify` or `object` from the named reviewer, or it is reported as unmet in the terminal record.
