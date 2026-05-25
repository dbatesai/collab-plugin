/**
 * collab-status.mjs — terminal status display. Read-only, no event emitted.
 * CLI: node collab-status.mjs <slug>
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findCollabDir, readEvents, getJoinedAgents, isClosed, findActiveProposeClose, checkSafetyNets } from './collab-event-helpers.mjs';

export function printStatus(events, slug) {
  const kickoff = events.find(e => e.type === 'kickoff');
  const closeEvt = events.find(e => e.type === 'close');
  const joined = getJoinedAgents(events);
  const propose = findActiveProposeClose(events);
  const net = checkSafetyNets(events, new Date().toISOString());

  const state = closeEvt ? `CLOSED (${closeEvt.payload.outcome})` : propose ? 'PROPOSE-CLOSE PENDING' : 'ACTIVE';
  console.log(`\n── collab: ${slug} ──────────────────────────────`);
  console.log(`State: ${state}  |  Events: ${events.length}  |  Participants: ${joined.length}`);
  if (net) console.log(`Safety net triggered: ${net}`);
  if (kickoff?.payload?.igm) {
    const { intention, goal, measure } = kickoff.payload.igm;
    console.log(`\nIGM:\n  Intention: ${intention}\n  Goal: ${goal}\n  Measure: ${measure}`);
  }
  console.log(`\nParticipants: ${joined.join(', ') || '(none)'}`);
  if (propose) console.log(`\nPropose-close by ${propose.author} (${propose.event_id})`);
  console.log('\nRecent (last 5):');
  for (const e of events.slice(-5).reverse()) console.log(`  ${e.ts} [${e.type}] ${e.author}`);
  console.log('');
}

export function main(argv) {
  const slug = argv[0];
  if (!slug) { process.stderr.write('usage: collab-status.mjs <slug>\n'); return 2; }
  const dir = findCollabDir(slug);
  if (!dir) { process.stderr.write(`no collab: ${slug}\n`); return 2; }
  printStatus(readEvents(dir), slug);
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
