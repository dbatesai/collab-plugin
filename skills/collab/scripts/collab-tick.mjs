/**
 * collab-tick.mjs — one iteration of the collab loop.
 * Called by /loop 30m every 30 minutes.
 * Deterministic state machine; LLM only for turn content.
 * CLI: node collab-tick.mjs <slug> [--workspace-id <id>] [--triplet <t>] [--dry-run]
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findCollabDir, readEvents, nextEventId, appendEvent,
  deriveTriplet, hasJoined, isClosed,
  checkSafetyNets, findActiveProposeClose, getRatificationStatus,
  gitPullRebase, gitCommitPush,
} from './collab-event-helpers.mjs';
import { render } from './collab-render.mjs';

/**
 * Deterministic route detection. Pure function — no LLM, no I/O.
 * Returns: 'closed' | 'safety-net:<type>' | 'emit-close' | 'ratify-or-object' | 'turn-or-propose' | 'not-joined'
 */
export function detectRoute(events, triplet, nowTs) {
  if (isClosed(events)) return 'closed';
  const net = checkSafetyNets(events, nowTs);
  if (net) return `safety-net:${net}`;
  const ratStatus = getRatificationStatus(events);
  if (ratStatus) {
    if (ratStatus.converged && ratStatus.proposeClose.author === triplet) return 'emit-close';
    if (ratStatus.proposeClose.author !== triplet && ratStatus.pending.includes(triplet)) return 'ratify-or-object';
  }
  return 'turn-or-propose';
}

export async function tick(slug, options = {}) {
  const { workspaceId = 'unknown', triplet: givenTriplet, dryRun = false } = options;
  const nowTs = new Date().toISOString();
  if (!dryRun) gitPullRebase();

  const dir = findCollabDir(slug);
  if (!dir) throw new Error(`no collab directory for slug: ${slug}`);
  const events = readEvents(dir);
  const triplet = givenTriplet || deriveTriplet(workspaceId);

  if (!hasJoined(events, triplet)) {
    process.stderr.write(`warn: ${triplet} has not joined ${slug}\n`);
    return { action: 'not-joined' };
  }

  const route = detectRoute(events, triplet, nowTs);

  if (route === 'closed') {
    process.stdout.write(`${slug} is closed. Cancel /loop.\n`);
    return { action: 'exit' };
  }

  if (route.startsWith('safety-net:')) {
    const net = route.split(':')[1];
    const outcomes = { 'wall-clock':'aborted-budget', 'stall':'aborted-stall', 'objection-deadlock':'aborted-objection' };
    const ev = {
      event_id: nextEventId(events), ts: nowTs, author: triplet, slug, type: 'close', references: [],
      payload: { final_synthesis: `Safety net: ${net}`, outcome: outcomes[net] },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      gitCommitPush(dir, `[${triplet}] close: ${slug} ${ev.event_id} (${outcomes[net]})`);
    }
    return { action: 'close', reason: net, event: ev };
  }

  if (route === 'emit-close') {
    const rat = getRatificationStatus(events);
    const ev = {
      event_id: nextEventId(events), ts: nowTs, author: triplet, slug, type: 'close',
      references: [rat.proposeClose.event_id],
      payload: { final_synthesis: rat.proposeClose.payload.synthesis, outcome: 'converged' },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      gitCommitPush(dir, `[${triplet}] close: ${slug} ${ev.event_id} (converged)`);
    }
    return { action: 'close', reason: 'converged', event: ev };
  }

  if (route === 'ratify-or-object') {
    const decision = await _decidRatifyOrObject(events, triplet);
    const rat = getRatificationStatus(events);
    const ev = {
      event_id: nextEventId(events), ts: nowTs, author: triplet, slug, type: decision.type,
      references: [rat.proposeClose.event_id],
      payload: decision.type === 'ratify' ? { agreement_notes: decision.notes } : { reason: decision.reason },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      gitCommitPush(dir, `[${triplet}] ${decision.type}: ${slug} ${ev.event_id}`);
    }
    return { action: decision.type, event: ev };
  }

  // turn-or-propose: LLM decides (stub in P1)
  const decision = await _decideTurnOrPropose(events, triplet);
  if (!decision) return { action: 'idle' };

  const ev = {
    event_id: nextEventId(events), ts: nowTs, author: triplet, slug, type: decision.type,
    references: decision.referencedIds || [], payload: decision.payload,
  };
  if (!dryRun) {
    appendEvent(dir, ev);
    await render(slug, { collabDir: dir, author: triplet });
    gitCommitPush(dir, `[${triplet}] ${decision.type}: ${slug} ${ev.event_id}`);
  }
  return { action: decision.type, event: ev };
}

// P1 stubs — replaced by LLM reasoning in P2
async function _decideTurnOrPropose(_events, _triplet) { return null; }
async function _decidRatifyOrObject(_events, _triplet) { return { type: 'ratify', notes: '(stub)' }; }

export function main(argv) {
  let slug = null, workspaceId = null, dryRun = false, triplet = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--triplet') triplet = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (!argv[i].startsWith('--')) slug = argv[i];
  }
  if (!slug) { process.stderr.write('usage: collab-tick.mjs <slug> [--workspace-id <id>]\n'); return 2; }
  tick(slug, { workspaceId, triplet, dryRun })
    .then(r => { process.stdout.write(`tick: ${JSON.stringify(r)}\n`); if (r.action === 'exit') process.exit(0); })
    .catch(e => { process.stderr.write(`tick error: ${e.message}\n`); process.exit(1); });
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
