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

`--measure "<id>|<description>|<participant-triplet>"` (repeatable) declares a completion measure: a condition with an id, a description that says what done looks like, and the participant whose review discharges it. **A kickoff that wants other participants (`capabilities_wanted` non-empty) must declare at least one measure** — the writer refuses it otherwise with `completion-measures-required`. A solo kickoff needs none. The description has to be real: the inferred placeholder text is refused (`completion-measure-placeholder: <id>`), as are a missing reviewer, an empty description, or a duplicate id (`completion-measure-invalid: <id>`).

`--required-review <participant-triplet>` (optional; repeatable) is the short form: it generates one measure, `independent-review-<participant>`, whose reviewer is that participant. Both flags merge onto `ratified_completion_measures` on the kickoff payload.

Write measures per phase, not one for the whole goal. A single "the design is accepted" measure hides where a session actually stalled; three measures — the spec is reviewed, the adapter conforms, the Windows run is clean — let a reviewer discharge what they have seen and leave the rest visibly open. What the declaration changes at tick time: silence from a named reviewer never ratifies, a verdict from a named reviewer has to say which measures it judges, and the close outcome is computed from the measures rather than from who went quiet.

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
import {findCollabDir, readEvents, generateEventId, authorSlugFromTriplet, appendEvent, channelIdentity, gitPullRebase, gitCommitPush} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
gitPullRebase('<transport>');   // e.g. 'github:files' — required; omitting it throws
const dir = findCollabDir('<slug>');
const events = readEvents(dir);
const me = channelIdentity(events, '<workspace_id>');   // minted once, then read back; never re-sniffed
const triplet = me.triplet;
const ev = { event_id: generateEventId(new Date().toISOString(), authorSlugFromTriplet(triplet)), ts: new Date().toISOString(), author: triplet,
  participant_id: me.participant_id, harness: me.harness, slug: '<slug>',
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
- `{ action: "contract-invalid", errors, repair }` — the kickoff's declared measures would not pass this plugin's writer (a hand edit, or an older writer) and a second participant has joined. Nothing was written. Follow `repair`: close the session `failed-safely` and kick off again with valid `--measure` flags.
- `{ action: "not-joined" }` — bug or weird state; ask the user.

Route precedence, in order: `closed` → `contract-invalid` → the safety nets → the close routes (authority boundary, `emit-close`) → the decision routes (`ratify-or-object`, `turn-or-propose`). Obligations — due fallbacks, chases, wait-cycle notices — are handled on **both** decision routes, so a proposal on the table never postpones a due fallback. On a git transport every tick route that publishes — the decision routes, the three close routes, and the `closed` exit — goes through one delivery step that publishes **what this participant's plugin wrote and nothing else**. Ownership is evidence, not location: a new file under `events/` whose name is its event id and whose author is the ticking participant, or bytes this participant's plugin recorded *at that path* when it wrote them (renders and `KICKOFF.md`, kept as path → blob hash in a manifest outside the repository, `~/.collab/delivery/<participant>/`). Bytes recorded for one path authorize no other. That rule is applied in every state, and it is end to end: on a git transport the renders are derived only from events this participant may publish — its own new events, published events whose bytes *as parsed* equal the upstream's blob, and events published as a line of the upstream's `events.jsonl` — so an unpublished peer event, a local edit to any published event (the participant's own included), or a file that borrows a published event's id under another name never travels through `events.jsonl` or `turns/`. The reader binds each event to its source file and blob id in the same read, so the evidence is of the bytes in hand and no re-read window exists. A file under `events/` whose name is not its event id is a **hard stop**: the tick returns `{ action: 'refused', reason: 'event-filename-violation', paths }` and appends, derives, and publishes nothing until it is renamed or moved out; `collab-validate` reports it as an error; `status` still reads the channel (skipping the file) so a person can see what is wrong. One published event may exist in two representations — an upstream event file and an upstream `events.jsonl` line — and a local file that contradicts either is a *conflict*, not an input and not a new event, whoever wrote it: the render derives from the published representation (so published content is never erased), the local bytes stay on disk, the raw file is listed as not-ours and never delivered, and the tick result names it in `render_conflicts`; and a render replaces an existing file only when that file is a render this participant recorded or the bytes the upstream holds, otherwise the file is preserved and reported in `render_blocked`. The manifest is evidence of what this machine's plugin wrote for this participant; it is not authentication of the participant. It is written atomically, and an unreadable or torn manifest reads as empty — a render with no evidence is listed as foreign and preserved, never published. Uncommitted owned files are committed `--only` those paths, so an unrelated staged entry stays staged; another participant's unpublished file and any stray draft are reported in `delivery.foreign_paths` and never staged; a tracked file modified into something unowned, or deleted, blocks delivery. Every commit ahead of the upstream is inspected blob by blob — a committed draft inside the channel, or a committed hand edit to an event, blocks the push (`delivery.blocked`) and is preserved; nothing is cleaned up to get past a block. The push is verified against the upstream ref (`delivery.verified`); a clean working tree is not a delivery receipt, a tick with nothing owed commits nothing, and a `closed` session whose close never reached the remote is delivered by the next tick before it exits.

Every `agent-decision-needed` result also carries `open_requests` — the turns from other participants whose `waiting_on` names you, with their state (`requested` or `accepted`), deadline, and the requester's fallback — and `wait_cycles`, any pair in which two participants are each waiting on the other. Read `open_requests` before deciding what to emit: a request stays open until you reference it with a `declined` or `delivered` signal, or answer it with a scoped verdict. See "Requests you can see" below.

#### Ratify or object

Another agent proposed close. You have 3 of your own ticks to decide (≈90 minutes at the standard 30-min /loop cadence). If you stay silent for that window — emit no events at all — you'll be treated as having implicitly ratified. This is intentional: peers who go offline (usage limit, machine down, network issue) shouldn't block convergence forever.

**Unless your own review is a ratified completion measure.** If the kickoff named you in `ratified_completion_measures`, your silence never ratifies, however long it runs. There the review *is* the measure, so silence is the missing evidence rather than consent to close without it — reading it as an accept would manufacture the very verdict the measure exists to require. Emit `ratify` or `object`; nothing else discharges it. Check the propose-close status block in `STATUS.md`: it lists who is pending under silence-ratifies and who is owed a review that silence cannot cover.

1. Read the propose-close event (the last `type: propose-close` in events.jsonl with no following object/close).
2. Read its `synthesis` and `igm_met` against the kickoff's IGM.
3. Decide: does the synthesis genuinely address each IGM dimension? If yes → emit `ratify`. If no → emit `object` with a specific reason.

Use the same `node --input-type=module -e "..."` pattern as join, with `type: 'ratify'` and `payload: { agreement_notes: '<optional>' }` OR `type: 'object'` and `payload: { reason: '<what-is-missing>' }`. Set `references: ['<propose-close-event-id>']`.

**If the kickoff names you as a reviewer, your verdict is scoped.** Add `measures: ['<id>', ...]` to the payload, listing exactly the measures you have judged and no others. `appendEvent` refuses a verdict from a named reviewer without it (`verdict-unscoped: <you> owes <ids>`); the validator refuses an id you do not owe (`verdict-reviewer-mismatch`) or that nobody declared (`measure-unknown`), and either refusal drops the whole event — there is no partial credit. You may judge your measures in separate events, and you may judge a measure before any propose-close exists: a scoped verdict counts from the moment it lands until the session closes. The first judgment you give a measure stands; a second verdict on the same id is refused as `verdict-duplicate` and reads as correspondence. That is a known limitation of v1 — there is no way to retract a scoped verdict short of the proposer re-kicking off. A participant who owes no measure ratifies or objects to the synthesis as a whole; a `measures` field from them is ignored with a warning.

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

When the user doesn't name a slug (or asks "what collabs are running?"), enumerate channels across all transports first:

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-list.mjs [localhost|github:<repo>] [--closed | --all]
```

When a channel looks corrupt or a peer's events aren't landing, run the schema check before debugging by hand — it reports every malformed event with its line number:

```bash
node ${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-validate.mjs <slug>
```

Both are read-only. No event emitted.

### Route: abort

Emit a close event with `outcome: 'aborted-david'`:

```bash
node --input-type=module -e "
import {findCollabDir, readEvents, generateEventId, authorSlugFromTriplet, appendEvent, channelIdentity, gitPullRebase, gitCommitPush} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-event-helpers.mjs';
import {render} from '${COLLAB_PLUGIN_ROOT}/skills/collab/scripts/collab-render.mjs';
gitPullRebase('<transport>');   // e.g. 'github:files' — required; omitting it throws
const dir = findCollabDir('<slug>');
const events = readEvents(dir);
const me = channelIdentity(events, '<workspace_id>');   // minted once, then read back; never re-sniffed
const triplet = me.triplet;
const ev = { event_id: generateEventId(new Date().toISOString(), authorSlugFromTriplet(triplet)), ts: new Date().toISOString(), author: triplet,
  participant_id: me.participant_id, harness: me.harness, slug: '<slug>',
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
- If you have no firm commitment, use an empty string (`""`). **An empty or absent deadline is not "no deadline": it defaults to your turn's timestamp plus one tick cadence**, computed by every reader and never written back.
- `on_timeout` names what happens when your deadline lapses: `proceed-alone`, `reassign`, `degrade-and-continue`, or `close-degraded`. Absent, it defaults to `proceed-alone` — the one action that moves no ownership. A value outside that list is refused as an unbounded wait.
- **The first tick at or after your deadline executes the fallback**, whoever runs that tick — another participant's, or your own, since a counterpart who is not there is exactly the case the bound is for. It executes once per deadline and leaves a `timeout-action` event; a later tick never re-executes it, however late. Chases are reminders, not the bound: they start after the 5-minute grace, stop at the flood limit, and never move the deadline in either direction.
- Only your own next substantive turn resets your deadline. A chase from the other side never does, and neither default ever moves the wall-clock or stall nets.

Set a realistic deadline. Setting it far in the future to avoid chases defeats the accountability mechanism. A 20–30 minute window for plan work, 5 minutes for quick factual replies.

### Requests you can see

Every v1 turn names `waiting_on`. From this version the recipient's side reads it: a turn whose `waiting_on` is you is an open request on you, listed in the tick result's `open_requests` and in the **Waiting** table in `STATUS.md` (requester → recipient, since, deadline, fallback, state). A request moves through `requested` → `accepted` → `delivered`, or ends `declined` or `lapsed`:

- Reference the request's event id and put `accepted`, `declined`, or `delivered` in `signals`. `accepted` changes the state, not the visibility — the request stays open until `delivered` or `declined`.
- A `ratify`/`object` that references the request delivers it **only if the reader credits that verdict** — the same rule as measure credit: a verdict refused for an unknown id, a measure you do not owe, or a measure you already judged delivers nothing, and neither does a bare one. A request may say what it is about with `measures: ['<id>', ...]` on the turn; then only a credited verdict on one of those ids delivers it. A request that names no measure is delivered by any credited verdict that references it.
- Any other turn that merely references the request changes nothing. A clarifying question, a progress note, a later mention: the request is still open. Only the signals above, a credited verdict, or the requester's own timeout fallback resolve it.
- `lapsed` is the requester's timeout action executing at the first tick at or after the request's deadline — the request is closed for the requester, and whatever measure it was about is still unmet.

A **wait cycle** is two participants each holding an open request on the other. The tick reports it in `wait_cycles` and records it once per pair as a system turn (`signals: ['wait-cycle', <a>, <b>]`), keyed by the two request ids so an unchanged pair is not re-announced. Acceptance on both sides is still a cycle. One side has to deliver, decline, or let its deadline lapse; the first authorized tick at or after that deadline takes the declared fallback.

**Reread before you write.** Between reading the ledger and appending your event another participant may have delivered, declined, or closed. Re-read the ledger immediately before emitting a verdict or a close, and reference the event you are answering. This is a convention, not a guarantee: two writers can still read the same state and both append, and v1 does not detect that race — it is recorded as follow-up work, not solved here.

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

The flood limit is 3 chase events per participant per 60-minute window. Chases are reminders; they do not gate anything. Your `on_timeout` action (default `proceed-alone`) executes at the first tick at or after your deadline, whether or not any chase was ever sent, and is recorded once as a `timeout-action` event — silence does not make the obligation disappear; it makes the declared fallback happen.

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
- **Silence-as-ratification stops at a ratified completion measure.** A kickoff may declare `ratified_completion_measures: [{ id, description, requires_review_from }]`. Silence from a named reviewer never ratifies. This is a narrowing of the rule above, not a repeal: every participant not named still ratifies by going quiet.
- **A session with declared measures closes by its contract, on either route.** The proposer's close and the stall net use one calculation: any measure objected to → `failed-safely`; otherwise any measure ratified → `complete-to-authority-boundary`; nothing judged → `failed-safely`. Only the proposer route, with every measure ratified by its named reviewer and the synthesis ratified, closes `converged`. The close carries a receipt — `ratified_measures`, `objected_measures` (with reasons), `unmet_ratified_measures`, `missing_reviews_from`, `ratified_by`, and a note that says which route closed it. `aborted-stall` is the stall net's word for a ledger with no declared measures.
- **A missing ratified review cannot be waived by degrading the result.** There is no outcome that closes a goal as done-with-caveats over a measure that has no evidence receipt. The measure is either discharged by a real `ratify` or `object` from the named reviewer, or it is reported as unmet in the terminal record.
- **Interpret by shape, guarantee at write.** A verdict with a `measures` field is scoped: it credits exactly those ids, from the moment it lands until the close. A verdict without one from a named reviewer is the legacy shape: read author-wide, scoped to the propose-close on the table, exactly as 1.1.0 read it — so a 1.1.0 ledger computes the same outcome and the same unmet list it always did. Each credit in a receipt is labeled `scope: 'scoped'` or `scope: 'legacy'` to say how it was read. The plugin guarantees what its writer emits — every kickoff it creates for a non-solo session declares valid measures, and every verdict it writes from a named reviewer is scoped. It does not guarantee that every ledger the reader accepts contains scoped agreement. A `scope: 'legacy'` label on a credit records how that credit was interpreted; it does not prove the event's age, its writer, or explicit measure-level assent.
