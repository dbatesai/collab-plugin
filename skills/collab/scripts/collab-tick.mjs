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
  deriveTriplet, hasJoined, isClosed,
  checkSafetyNets, findActiveProposeClose, getRatificationStatus,
  getJoinedAgents, unmetRequiredReviews,
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
    // A ratified completion measure with no review attached cannot be closed as success
    // and cannot be waived by declaring the result degraded. The proposer closes at the
    // authority boundary instead, naming what never arrived.
    if (ratStatus.proposeClose.author === triplet && unmetRequiredReviews(events, nowTs).length > 0) {
      return 'terminal:authority-boundary';
    }
    if (ratStatus.converged && ratStatus.proposeClose.author === triplet) return 'emit-close';
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
  const triplet = givenTriplet || deriveTriplet(workspaceId);
  if (!dryRun) quarantineInvalidV1Events(dir, { author: triplet });
  const events = readEvents(dir);
  const transport = transportFromEvents(events);
  if (!dryRun && isGitTransport(transport)) gitPullRebase(transport);

  if (!hasJoined(events, triplet)) {
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

  if (route.startsWith('safety-net:')) {
    const net = route.split(':')[1];
    const outcomes = { 'wall-clock':'aborted-budget', 'stall':'aborted-stall', 'objection-deadlock':'aborted-objection' };
    const ev = {
      event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug, type: 'close', references: [],
      payload: { final_synthesis: `Safety net: ${net}`, outcome: outcomes[net] },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      if (isGitTransport(transport)) gitCommitPush(dir, transport, `[${triplet}] close: ${slug} ${ev.event_id} (${outcomes[net]})`);
    }
    return { action: 'close', reason: net, event: ev };
  }

  if (route === 'terminal:authority-boundary') {
    const rat = getRatificationStatus(events, nowTs);
    const unmet = unmetRequiredReviews(events, nowTs);
    const ev = {
      event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug,
      type: 'close', references: [rat.proposeClose.event_id],
      payload: {
        final_synthesis: rat.proposeClose.payload.synthesis,
        outcome: 'complete-to-authority-boundary',
        // What did not arrive, named. A terminal record that does not say this is just
        // a different word for the same silence.
        unmet_ratified_measures: unmet,
        missing_reviews_from: unmet.map(m => m.requires_review_from),
        // Only real verdicts. Nothing here is inferred from silence.
        ratified_by: rat.explicitRatified,
        note: 'Closed at the authority boundary. Every ratified completion measure that has an '
            + 'evidence receipt is included above; the reviews named in unmet_ratified_measures '
            + 'never arrived and were not waived. This is not a consensus and must not be '
            + 'described as one.',
      },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      if (isGitTransport(transport)) {
        gitCommitPush(dir, transport, `[${triplet}] close: ${slug} ${ev.event_id} (complete-to-authority-boundary)`);
      }
    }
    return { action: 'close', reason: 'authority-boundary', event: ev };
  }

  if (route === 'emit-close') {
    const rat = getRatificationStatus(events, nowTs);
    const ev = {
      event_id: generateEventId(nowTs, authorSlugFromTriplet(triplet)), ts: nowTs, author: triplet, slug, type: 'close',
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
  if (route === 'turn-or-propose') {
    const joined = getJoinedAgents(events);
    const nowDate = new Date(nowTs);
    for (const participant of joined) {
      if (participant === triplet) continue; // don't chase ourselves
      const theirEvents = events.filter(e => e.author === participant && e.type === 'turn');
      const last = theirEvents[theirEvents.length - 1];
      if (!last?.payload?.next_update_by) continue; // no commitment → no chase
      // Only chase on strict ISO 8601 deadlines — human-readable strings (e.g., '1:00 AM EDT')
      // can be parsed by new Date() but are unreliable and represent the HC watcher interop bug.
      // Skipping them here means non-ISO timestamps don't trigger spurious chases.
      const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
      if (!ISO_8601_RE.test(last.payload.next_update_by)) continue;
      const deadline = new Date(last.payload.next_update_by);
      const gracePeriodMs = 5 * 60 * 1000;
      if (nowDate - deadline < gracePeriodMs) continue; // within grace → no chase yet
      const driftSeconds = Math.round((nowDate - deadline) / 1000);

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
        ts: nowTs, author: triplet, slug,
        type: 'turn', references: [last.event_id],
        payload: {
          schema_version: '1.0',
          intent: 'clarify', state: 'blocked',  // obligation-missed → blocked on other participant
          owner: participant, waiting_on: participant,
          next_update_by: '', // HK has no commitment here — chase is a system event
          body: `Obligation missed: ${participant} expected update by ${localTimeStr(last.payload.next_update_by)}. ` +
                `Drift: ${Math.round(driftSeconds / 60)} min. State unknown.`,
          participant_obligation: {
            participant, drift_seconds: driftSeconds,
            last_committed_next_update_by: last.payload.next_update_by,
            commitment_drift_state: driftSeconds > gracePeriodMs / 1000 ? 'missed' : 'late',
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
  }

  // LLM-decision routes: return a hint, let the agent take over
  return { action: 'agent-decision-needed', route, triplet, slug, chase_events_emitted: chaseEvents.length };
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
