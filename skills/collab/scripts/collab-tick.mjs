/**
 * collab-tick.mjs — deterministic tick handler.
 *
 * Run by the agent (or /loop) on each tick. Handles only deterministic paths:
 *   - 'closed': prints exit signal
 *   - 'safety-net:*': emits close event with appropriate outcome
 *   - 'emit-close': agent already proposed close and ratification converged — emit final close
 *
 * For LLM-decision paths ('ratify-or-object', 'turn-or-propose'), exits with
 * exit code 0 and prints JSON: { action: 'agent-decision-needed', route, ... }.
 * The agent reads the stdout JSON and walks through the SKILL.md algorithm.
 *
 * CLI: node collab-tick.mjs <slug> [--workspace-id <id>] [--triplet <t>] [--dry-run]
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findCollabAcrossTransports, readEvents, generateEventId, authorSlugFromTriplet, appendEvent,
  channelIdentity, hasJoinedIdentity, isClosed,
  checkSafetyNets, findActiveProposeClose, getRatificationStatus,
  getJoinedAgents, computeCloseOutcome, validateMeasures,
  openRequests, waitCycles, effectiveDeadline, effectiveOnTimeout, executeTimeoutAction, isSystemTurn,
  CHASE_FLOOD_LIMIT, OBLIGATION_GRACE_MS,
  gitPullRebase, gitCommitPush,
  checkMinVersion, readLocalPluginVersion,
  detectHarness,
} from './collab-event-helpers.mjs';
import { isGitTransport } from './transport.mjs';
import { render } from './collab-render.mjs';
import { quarantineInvalidV1Events } from './collab-v1-quarantine.mjs';

/** Render 12-hour local system time with full date, seconds, and real tz abbrev. */
function localTimeStr(iso) {
  if (!iso) return '(none)';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const parts = new Intl.DateTimeFormat('en-US', {
      hour12: true, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
    }).formatToParts(d);
    const get = (t) => (parts.find(p => p.type === t)?.value ?? '');
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod')} ${get('timeZoneName')}`;
  } catch { return iso; }
}

function transportFromEvents(events) {
  const k = events.find(e => e.type === 'kickoff');
  return k?.payload?.transport || 'github:files';
}

export function detectRoute(events, triplet, nowTs) {
  if (isClosed(events)) return 'closed';
  const net = checkSafetyNets(events, nowTs);
  if (net) return `safety-net:${net}`;
  const ratStatus = getRatificationStatus(events, nowTs);
  // Treat objected propose-closes as dead (findActiveProposeClose semantics).
  // The ratStatus still reports them for visibility, but tick routing skips them.
  if (ratStatus && ratStatus.objected.length === 0) {
    // A session with declared measures closes by its contract. Unless every measure carries
    // a ratify from its named reviewer and the synthesis is ratified, the proposer closes at
    // the authority boundary, naming what never arrived and what was objected to — success
    // cannot be declared over a missing review, and degradation cannot waive one.
    if (ratStatus.proposeClose.author === triplet) {
      const contract = computeCloseOutcome(events, nowTs, { route: 'proposer' });
      if (contract && contract.outcome !== 'converged') return 'terminal:authority-boundary';
      if (ratStatus.converged) return 'emit-close';
    }
    if (ratStatus.proposeClose.author !== triplet && ratStatus.pending.includes(triplet)) return 'ratify-or-object';
  }
  return 'turn-or-propose';
}

/**
 * Run the deterministic part of a tick. Returns { action, ... }.
 * For LLM-decision routes, the agent takes over from here.
 */
export async function tickDeterministic(slug, options = {}) {
  const { workspaceId = 'unknown', triplet: givenTriplet, dryRun = false } = options;
  const nowTs = new Date().toISOString();

  const hit = findCollabAcrossTransports(slug);
  if (!hit) throw new Error(`no collab directory for slug: ${slug}`);
  const dir = hit.dir;
  // v1.0 #3: quarantine invalid v1 events before routing so chase/tick logic
  // never operates on malformed or non-ISO-timestamp events. readEvents then
  // skips the .quarantined- dotfiles, so the routing sees only valid events.
  // Resolve identity first: quarantine needs an author so it can emit a ROUTED notice.
  // Without one it would preserve the bytes and announce nothing, leaving a suppressed
  // peer event visible only to whoever inspects the directory by hand.
  //
  // The ledger is read before identity resolves, because the identity this channel already
  // admitted outranks anything this machine would mint — that is what lets a channel whose
  // join events predate participant ids keep resolving.
  const identity = givenTriplet
    ? { triplet: givenTriplet, participant_id: null, harness: detectHarness() }
    : channelIdentity(readEvents(dir), workspaceId);
  const triplet = identity.triplet;
  if (!dryRun) quarantineInvalidV1Events(dir, { author: triplet });
  const events = readEvents(dir);
  const transport = transportFromEvents(events);
  if (!dryRun && isGitTransport(transport)) gitPullRebase(transport);

  // Advisory metadata stamped on everything this tick emits. Free to degrade; nothing
  // downstream routes on it.
  const stamp = { participant_id: identity.participant_id, harness: identity.harness };

  if (!hasJoinedIdentity(events, identity)) {
    // v0.2 version check: if kickoff specifies a min_collab_plugin_version, enforce it
    const kickoff = events.find(e => e.type === 'kickoff');
    const minVersion = kickoff?.payload?.min_collab_plugin_version;
    if (minVersion) {
      const localVersion = readLocalPluginVersion();
      const check = checkMinVersion(localVersion, minVersion);
      if (!check.ok) {
        return { action: 'version-too-low', error: check.error, localVersion, minVersion, slug };
      }
    }
    return { action: 'not-joined', triplet, slug };
  }

  const route = detectRoute(events, triplet, nowTs);

  if (route === 'closed') {
    return { action: 'exit', reason: 'closed', slug };
  }

  // A declaration this plugin would not have written (a hand edit, an older writer) is
  // refused once a second participant has joined it: there is no contract to compute an
  // outcome from, and nothing here may guess one. Absent measures are the legacy shape.
  const declared = events.find(e => e.type === 'kickoff')?.payload?.ratified_completion_measures;
  if (Array.isArray(declared) && declared.length > 0) {
    const errors = validateMeasures(declared);
    const joiners = new Set(events.filter(e => e.type === 'join').map(e => e.author));
    if (errors.length && joiners.size >= 2) {
      return {
        action: 'contract-invalid', errors, slug, triplet,
        repair: 'close this session failed-safely and kick off again with valid --measure flags',
      };
    }
  }

  if (route.startsWith('safety-net:')) {
    const net = route.split(':')[1];
    const outcomes = { 'wall-clock':'aborted-budget', 'stall':'aborted-stall', 'objection-deadlock':'aborted-objection' };
    // The stall net on a session with declared measures closes by the same calculation the
    // proposer route uses; `aborted-stall` is the legacy word for a ledger with no contract.
    const contract = net === 'stall' ? computeCloseOutcome(events, nowTs, { route: 'stall' }) : null;
    const payload = contract
      ? { final_synthesis: `Safety net: ${net}`, outcome: contract.outcome, ...contract.receipt }
      : { final_synthesis: `Safety net: ${net}`, outcome: outcomes[net] };
    const ev = {
      event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug, ...stamp, type: 'close', references: [],
      payload,
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      if (isGitTransport(transport)) gitCommitPush(dir, transport, `[${triplet}] close: ${slug} ${ev.event_id} (${payload.outcome})`);
    }
    return { action: 'close', reason: net, event: ev };
  }

  if (route === 'terminal:authority-boundary') {
    const rat = getRatificationStatus(events, nowTs);
    const contract = computeCloseOutcome(events, nowTs, { route: 'proposer' });
    const ev = {
      event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug, ...stamp,
      type: 'close', references: [rat.proposeClose.event_id],
      // The receipt names what arrived, what was objected to, and what never came. A
      // terminal record that does not say this is just a different word for the same silence.
      payload: { final_synthesis: rat.proposeClose.payload.synthesis, outcome: contract.outcome, ...contract.receipt },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      if (isGitTransport(transport)) {
        gitCommitPush(dir, transport, `[${triplet}] close: ${slug} ${ev.event_id} (${contract.outcome})`);
      }
    }
    return { action: 'close', reason: 'authority-boundary', event: ev };
  }

  if (route === 'emit-close') {
    const rat = getRatificationStatus(events, nowTs);
    const ev = {
      event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug, ...stamp, type: 'close',
      references: [rat.proposeClose.event_id],
      payload: { final_synthesis: rat.proposeClose.payload.synthesis, outcome: 'converged' },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      if (isGitTransport(transport)) gitCommitPush(dir, transport, `[${triplet}] close: ${slug} ${ev.event_id} (converged)`);
    }
    return { action: 'close', reason: 'converged', event: ev };
  }

  // v1.0 #6: deterministic chase emission before handing off to LLM.
  // Check per-participant obligations; emit chase events for missed + grace-elapsed
  // participants. Flood-limited to 3 chase events per participant per 60 minutes.
  const chaseEvents = [];
  const timeoutActions = [];
  if (route === 'turn-or-propose') {
    const joined = getJoinedAgents(events);
    const nowDate = new Date(nowTs);
    for (const participant of joined) {
      if (participant === triplet) continue; // don't chase ourselves
      // The participant's latest substantive turn is their commitment: the deadline it
      // declared, or its own timestamp plus one cadence. System turns commit nobody.
      const theirEvents = events.filter(e => e.author === participant && e.type === 'turn' && !isSystemTurn(e));
      const last = theirEvents[theirEvents.length - 1];
      if (!last) continue;
      const deadlineIso = effectiveDeadline(last, events);
      const deadline = new Date(deadlineIso);
      if (nowDate - deadline < OBLIGATION_GRACE_MS) continue; // within grace → no chase yet
      const driftSeconds = Math.round((nowDate - deadline) / 1000);

      // The chase sequence for this deadline. Once it is exhausted the declared (or default)
      // timeout action executes, once — chasing forever is the silent stall.
      const chasesForDeadline = events.filter(e => isSystemTurn(e) && e.author === triplet
        && (e.payload?.signals || []).includes('chase') && e.payload.signals.includes(participant)
        && new Date(e.ts) > deadline).length;
      if (chasesForDeadline >= CHASE_FLOOD_LIMIT) {
        const action = effectiveOnTimeout(last);
        const settled = events.some(e => e.type === 'timeout-action' && e.payload?.participant === participant
          && Date.parse(e.payload?.for_deadline || 0) === deadline.getTime());
        if (action && !settled) timeoutActions.push({ participant, action, for_deadline: deadlineIso, chases_so_far: chasesForDeadline });
        continue;
      }

      // Flood limit: count recent chase events targeting this participant in last 60 min
      const floodWindow = 60 * 60 * 1000;
      const recentChases = events.filter(e =>
        e.type === 'turn' && e.author === triplet &&
        Array.isArray(e.payload?.signals) && e.payload.signals.includes('chase') &&
        e.payload.signals.includes(participant) &&
        (nowDate - new Date(e.ts)) < floodWindow
      );
      if (recentChases.length >= 3) continue; // flood limit hit → skip

      const harness = detectHarness();
      const chaseEv = {
        event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)),
        ts: nowTs, author: triplet, slug, ...stamp,
        type: 'turn', references: [last.event_id],
        payload: {
          schema_version: '1.0',
          intent: 'clarify', state: 'blocked',  // obligation-missed → blocked on other participant
          owner: participant, waiting_on: participant,
          next_update_by: '', // HK has no commitment here — chase is a system event
          body: `Obligation missed: ${participant} expected update by ${localTimeStr(deadlineIso)}. ` +
                `Drift: ${Math.round(driftSeconds / 60)} min. State unknown.`,
          participant_obligation: {
            participant, drift_seconds: driftSeconds,
            last_committed_next_update_by: deadlineIso,
            commitment_drift_state: driftSeconds > OBLIGATION_GRACE_MS / 1000 ? 'missed' : 'late',
          },
          signals: ['chase', 'obligation-missed', participant],
          provenance: {
            emit_mode: 'automated',
            harness,
            machine: process.env.HOSTNAME || process.env.COMPUTERNAME || 'unknown',
            plugin_version: readLocalPluginVersion(),
            install_source: 'cache-path',
          },
        },
      };
      chaseEvents.push(chaseEv);
    }
    if (!dryRun && chaseEvents.length > 0) {
      for (const ev of chaseEvents) appendEvent(dir, ev);
      if (isGitTransport(transport)) {
        gitCommitPush(dir, transport, `[${triplet}] chase: ${chaseEvents.length} obligation(s) missed ${slug}`);
      }
    }
    if (!dryRun) for (const item of timeoutActions) executeTimeoutAction(dir, item, triplet);
  }

  // Requests you can see: what others are waiting on you for, and any pair waiting on each
  // other. A new pair is recorded once, as a system turn keyed by its two request ids, so the
  // ledger shows the cycle without a notice on every tick.
  const current = dryRun ? events : readEvents(dir);
  const open_requests = openRequests(current, triplet);
  const wait_cycles = waitCycles(current);
  const recorded = new Set(current.filter(e => isSystemTurn(e) && e.payload?.wait_cycle?.key).map(e => e.payload.wait_cycle.key));
  const newCycles = wait_cycles.filter(c => !recorded.has(c.key) && c.participants.includes(triplet));
  if (!dryRun && newCycles.length > 0) {
    for (const c of newCycles) {
      const other = c.participants.find(p => p !== triplet);
      appendEvent(dir, {
        event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug, ...stamp,
        type: 'turn', references: c.requests,
        payload: {
          schema_version: '1.0', intent: 'clarify', state: 'blocked', owner: triplet, waiting_on: null, next_update_by: '',
          body: `Wait cycle: ${triplet} is waiting on ${other} (${c.requests[0]}) while ${other} is waiting on ${triplet} (${c.requests[1]}). ` +
                'One side has to accept, decline, or deliver; the requester\'s timeout fallback lapses the request otherwise.',
          wait_cycle: { key: c.key, participants: c.participants, requests: c.requests },
          signals: ['wait-cycle', ...c.participants],
        },
      });
    }
    if (isGitTransport(transport)) gitCommitPush(dir, transport, `[${triplet}] wait-cycle: ${newCycles.length} pair(s) ${slug}`);
  }

  // LLM-decision routes: return a hint, let the agent take over
  return {
    action: 'agent-decision-needed', route, triplet, slug,
    chase_events_emitted: chaseEvents.length, timeout_actions_executed: dryRun ? 0 : timeoutActions.length,
    open_requests, wait_cycles,
  };
}

export function main(argv) {
  let slug = null, workspaceId = null, dryRun = false, triplet = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--triplet') triplet = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (!argv[i].startsWith('--')) slug = argv[i];
  }
  if (!slug) { process.stderr.write('usage: collab-tick.mjs <slug> [--workspace-id <id>]\n'); return 2; }
  tickDeterministic(slug, { workspaceId, triplet, dryRun })
    .then(r => {
      if (r.action === 'version-too-low') {
        process.stderr.write(`${r.error}\n`);
      }
      process.stdout.write(JSON.stringify(r) + '\n');
      if (r.action === 'exit') process.exit(0);
      if (r.action === 'version-too-low') process.exit(1);
    })
    .catch(e => { process.stderr.write(`tick error: ${e.message}\n`); process.exit(1); });
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
