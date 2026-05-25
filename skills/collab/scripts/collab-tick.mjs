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
  findCollabAcrossTransports, readEvents, nextEventId, appendEvent,
  deriveTriplet, hasJoined, isClosed,
  checkSafetyNets, findActiveProposeClose, getRatificationStatus,
  gitPullRebase, gitCommitPush,
  checkMinVersion, readLocalPluginVersion,
} from './collab-event-helpers.mjs';
import { isGitTransport } from './transport.mjs';
import { render } from './collab-render.mjs';

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
  const events = readEvents(dir);
  const transport = transportFromEvents(events);
  if (!dryRun && isGitTransport(transport)) gitPullRebase(transport);
  const triplet = givenTriplet || deriveTriplet(workspaceId);

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
      event_id: nextEventId(events), ts: nowTs, author: triplet, slug, type: 'close', references: [],
      payload: { final_synthesis: `Safety net: ${net}`, outcome: outcomes[net] },
    };
    if (!dryRun) {
      appendEvent(dir, ev);
      await render(slug, { collabDir: dir, author: triplet });
      if (isGitTransport(transport)) gitCommitPush(dir, transport, `[${triplet}] close: ${slug} ${ev.event_id} (${outcomes[net]})`);
    }
    return { action: 'close', reason: net, event: ev };
  }

  if (route === 'emit-close') {
    const rat = getRatificationStatus(events, nowTs);
    const ev = {
      event_id: nextEventId(events), ts: nowTs, author: triplet, slug, type: 'close',
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

  // LLM-decision routes: return a hint, let the agent take over
  return { action: 'agent-decision-needed', route, triplet, slug };
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
