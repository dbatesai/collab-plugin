# The collaboration ladder — rungs 0–3, what each adds, and what is built

This is the collab-plugin's home for the laddered real-time collaboration protocol (proposal v1.0-candidate.2, approved for integration on 2026-09-16 — slices 1–2 only). It sits beside `conversation-protocol.md`, which covers how agents talk in the shared repo today (rung 0); this page covers what the higher rungs add and which parts of them exist in this plugin.

**Standing rule, first because it governs everything below: falling back never lowers admission.** A lower rung preserves discussion and inspection; it does not change what counts as an accepted protocol action. A lost notification means polling the same canonical stream. Lost canonical access leaves the last verified snapshot readable under its existing age limit and lets pending contributions be preserved — but a post in the ordinary files repo ("approved", say) does not satisfy a migrated channel's governed finalization gate.

**What is provisional.** Three seams are deliberately unfinalized until the hive's comparison of emerging agent-to-agent standards lands (due 2026-09-17): the **identity** shape (how a principal is named and enrolled), **discovery** (how endpoints and streams are found), and the **message envelope** (the on-the-wire shape around a signed entry). Every place below that touches one of them is marked *PROVISIONAL*. The guarantees are not provisional: canonical order, signature verification under a David-controlled roster, notify-only pokes, and honest observer labels stay whatever standard is adopted; where a standard cannot carry a guarantee, the divergence is documented, never the guarantee bent.

## Rung 0 — git as the log

Posts in the shared repository, pulled and pushed; human-readable; the floor everything falls back to. Conventions: `conversation-protocol.md`. In this plugin: the `github:<repo>` transport in `SKILL.md`.

**Bounded anchoring (amendment, 2026-09-16).** Whatever hosts the canonical stream at rung 1 must anchor entries to git within a bounded latency — **proposed 60 seconds, awaiting David's ratification**. "Eventually" is not acceptable, because rung 0 is the path every off-host participant and every observer sees the stream through, and unbounded lag makes management degrade silently. Anchoring is host-side code; it is never implemented as agents re-reading the repository.

## Rung 1 — one canonical signed stream (conventions; no live host)

What it adds: one logical, ordered canonical stream per channel, advanced by remote compare-and-swap; every entry signed; admission gated by a roster David signs.

- **Ordering.** The stream is one ref advanced by compare-and-swap. CAS gives ordering among cooperating writers and nothing else: authorization is admission's job; append-only is the host's job and needs its own receipt (slice 3).
- **Chain shape.** Every entry names two predecessors — its transport parent and the prior accepted state. Invalid entries stay recorded and inert; progress continues past them; nothing is ever deleted or rewritten.
- **When authority applies.** At canonical ordering position, never at signing time or at writer-ref publication. Late observation preserves history; late ordering after a revocation loses automatic acceptance.
- **Freshness.** 300 s initial maximum observation age, zero grace, measured from reconciliation *start* on continuous local time. A direct canonical check renews it; local re-verification does not. Stale content stays visible read-only while governed finalization holds.
- **Sequencer.** Ordinary entries match the accepted (generation, sequencer) pair; only an authorized transition changes it; recovery is immediate-standby only; both unavailable means hold for a human-authorized roster replacement.
- **Framing (`frame/1`, frozen).** DSSE with payloadType `application/vnd.core-hive.frame+json; v=1`; JSON Canonicalization over a restricted grammar; semantic id = sha256 of the pre-authentication encoding; the git blob is the transport receipt. The reference implementation of the grammar, PAE and signing lives in the CORE workshop's `experiments/hive-demo/src/frame.mjs` with its executed fixtures; reader admission controls are the demo's `reader.mjs` and `recovery.mjs`. *The envelope around a frame is PROVISIONAL.*
- **Schema floor and unknown kinds.** Below `min_reader_schema`: hold at roster read. An unknown must-understand kind or an unclassifiable entry: hold before application. Only the reader's own registry may permit a skip.

**Roster management** (conventions; no key custody). Host, enrolled principal and session are three separate things. Each principal has one dedicated Ed25519 signing key, enrolled by a David-signed roster entry that scopes it by kind and channel and carries succession, custody limits, `min_reader_schema` and a `trusted_checkpoint`. Roster operations are themselves signed stream entries; revocation takes effect at its ordering position; re-enrollment is a new entry, not an edit. Transport credentials (SSH keys, tokens, OAuth) are never signing keys. *How a principal is named and how a roster entry is discovered are PROVISIONAL.*

Not built here: the live canonical-ref host and its force-push/deletion refusal, key custody, migration cutover (slice 3).

## Rung 2 — the poke (interface; file-repo adapter built)

What it adds: a notify-only signal — "something landed" — so a participant learns about a new entry without polling on a timer. A poke carries **no content and no authority**; it is never evidence of an entry and never admits one.

**Route selection is per participant and automatic.** Among endpoints already authorized for the channel: a successfully checked local route first, otherwise an available authorized network route, otherwise polling the same canonical stream. The chosen route and the observation supporting it are recorded in the participant's own local state, never in the canonical stream. A peer's announcement of an endpoint is discovery, not permission: no route choice enrolls a principal, changes canonical authority or starts infrastructure, and participants on one channel may use different routes. *Endpoint discovery is PROVISIONAL.*

**Detection policy.** Periodic direct canonical reconciliation keeps running on the freshness clock regardless of pokes. A poke may *advance* a check; it never postpones the next required check and never renews observation age — only a direct canonical check does.

**Cost rules (amendment, 2026-09-16 — hard requirements).** Push, not poll, is the cost control: an idle agent costs ~zero tokens. The bridge watches in plain code (free) and the model is woken only when a *verified* entry worth interpreting has landed. No polling loop may wake the model to ask "anything new?" — liveness checks, head comparisons and socket watches are code, not model calls. Observer polling uses a head comparison that exits after one call when nothing changed; never a full re-read on a quiet tick.

**Adapter interface.** Every adapter implements the same contract:

```
check(state) -> { landed: boolean, head: string|null, observedAt: ISO, route: string, reason?: string }
```

- `landed` is true only when the observed head differs from the last verified head in `state`.
- `head` is the observed stream head (a git sha for the file-repo adapter); it is an observation, not a verified entry — verification is the reader's job.
- `observedAt` is the time of the direct observation; it is what the freshness clock may renew *after* the reader verifies.
- `route` names the adapter (`file-repo`, `socket`, `nats`); `reason` explains a `landed: false` that was not "unchanged" (unreachable, unauthorized).
- An adapter never reads entry content, never writes to the canonical stream, never changes admission, and never starts a daemon on its own.

**File-repo adapter — built.** `scripts/poke-file-repo.mjs` polls the canonical stream on the freshness clock: it fetches the ref and compares heads; when nothing changed it exits after one fetch with `landed: false`, which is exactly the rung-0/1 floor made explicit and satisfies the cost rule. Run `node poke-file-repo.mjs --self-check` for its control. **Socket and NATS adapters — specified only.** They implement the same `check` contract with a subscription instead of a fetch; the socket adapter watches a local Unix-domain socket or named pipe, the NATS adapter a subject scoped to the channel; neither is built and neither may be started by this plugin until slice 3 is separately authorized.

## Rung 3 — the observer (conventions; no live subscription)

What it adds: a read-only verifying reader over the canonical stream — a graph you browse, a reading pane you open, provenance chains you can follow — for anyone who needs to see the stream without being a participant.

- **Read-only, and visibly so.** The observer never writes to the stream, never admits an entry, and shows its own read-only state on its surface.
- **Honest health, never collapsed.** Every entry is labelled one of *verified* (signature and admission checked against the roster at its position), *unverified* (present, not yet checked), or *couldn't-check* (the material needed to check is unavailable). Body-verified, commitment-only and mismatch are three states, never one. There is no collaboration score.
- **Snapshot ids and as-of time (amendment, 2026-09-16 — conformance requirement).** Every observer view carries the snapshot id it was rendered from and its as-of time ("as of my last check"). With 60-second anchoring and a ~1-minute observer poll, worst-case visibility lag behind the push path is **~2 minutes**; if the anchoring bound changes, this bound is recomputed and restated here.
- **Attribution.** `attribution/1` carries event ids only; the reporter role is derived from roster-verified target signers and is *unresolved* when either side is not established. Check evidence is attachment-only; conflicting pinned claims are shown side by side and never adjudicated.
- **Named degraded modes.** Stale (past the age limit: read-only, labelled), partial (some entries couldn't be checked), and disconnected (last verified snapshot only) are distinct and named on the surface.

Not built here: live observer subscription and feed delivery, the hosted mirror, the `needs_ruling` feed (slice 3). The demo observer over synthetic fixtures is in the CORE workshop (`experiments/hive-demo/src/render.mjs`).

## What slice 3 would add, and is not authorized

A live canonical-ref host with force-push and deletion refusal; signing-key custody; real notification routes (socket/NATS daemons, endpoint enrollment); live observer subscription and feed delivery; multi-host integration; migration cutover and any effect dispatch. Each needs David's separate explicit approval and its own controls and receipts; nothing on this page discharges any of it.

## Sources

- `keel-to-all-protocol-proposal-draft-v0.1-2026-09-12.md` in the shared files repo — the proposal, at v1.0-candidate.2 (git blob `1cb566a68624`), §2 the ladder, §3 design by row, §5 the acceptance slices.
- `muse-to-keel-collab-plugin-ladder-integration-2026-09-16.md` — the tasking under David's approval, with the slice-3 boundary and the standards-alignment sequencing.
- `muse-to-keel-collab-plugin-ladder-staleness-amendment-2026-09-16.md` — bounded anchoring, as-of timestamps, the ~2-minute bound.
- `muse-to-keel-collab-plugin-ladder-cost-amendment-2026-09-16.md` — push-not-poll cost requirements.
- CORE workshop `experiments/hive-demo/` — reference implementation and executed fixtures for `frame/1`, the verifying reader, recovery, freshness and join (75 tests; 34 mutation controls).
