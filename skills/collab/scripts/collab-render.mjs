/**
 * collab-render.mjs — render STATUS.md and turns/*.md from events.jsonl.
 * Idempotent. Commits + pushes after render.
 * CLI: node collab-render.mjs <slug>
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findCollabDir, readEvents, getJoinedAgents,
  findActiveProposeClose, getRatificationStatus,
  checkSafetyNets, gitCommitPush, authorSlugFromTriplet,
  STALL_TICKS, TICK_INTERVAL_MS,
} from './collab-event-helpers.mjs';

export function buildStatusMd(events, slug) {
  const kickoff = events.find(e => e.type === 'kickoff');
  const closeEvt = events.find(e => e.type === 'close');
  const joined = getJoinedAgents(events);
  const proposeClose = findActiveProposeClose(events);
  const ratStatus = getRatificationStatus(events);

  let state = 'active';
  if (closeEvt) state = `closed — ${closeEvt.payload.outcome}`;
  else if (proposeClose) state = 'propose-close-pending';

  const lines = [`# STATUS — ${slug}`, '', `## Current state: ${state}`, ''];

  if (kickoff?.payload?.igm) {
    const { intention, goal, measure } = kickoff.payload.igm;
    lines.push('## IGM', `**Intention:** ${intention}`, `**Goal:** ${goal}`, `**Measure:** ${measure}`, '');
  }

  lines.push('## Participants');
  if (joined.length === 0) { lines.push('*(none joined yet)*'); }
  else {
    lines.push('| Agent | Last event |', '|---|---|');
    for (const a of joined) {
      const last = [...events].reverse().find(e => e.author === a);
      lines.push(`| ${a} | ${last?.ts ?? '—'} |`);
    }
  }
  lines.push('');

  lines.push('## Recent activity (last 5)');
  for (const e of events.slice(-5).reverse()) lines.push(`- **${e.ts}** [${e.type}] ${e.author}`);
  lines.push('');

  if (proposeClose && ratStatus) {
    lines.push('## Propose-close status',
      `Proposed by: ${proposeClose.author}`,
      `Ratified: ${ratStatus.ratified.join(', ') || 'none'}`,
      `Pending (silence = ratify): ${ratStatus.pending.join(', ') || 'none'}`, '');
  }

  const now = new Date().toISOString();
  if (kickoff) {
    const wallH = kickoff.payload.wall_clock_hours ?? 24;
    const elH = ((new Date(now) - new Date(kickoff.ts)) / 3600000).toFixed(1);
    const stallMin = ((new Date(now) - new Date(events[events.length-1].ts)) / 60000).toFixed(0);
    lines.push('## Safety nets',
      `Wall-clock: ${elH}h / ${wallH}h`,
      `Stall: ${stallMin}min since last event / ${STALL_TICKS * TICK_INTERVAL_MS / 60000}min limit`, '');
  }

  return lines.join('\n');
}

export function buildTurnMd(event) {
  const parts = [
    `# Turn — ${event.event_id}`, '',
    `**Author:** ${event.author}`, `**Timestamp:** ${event.ts}`,
  ];
  if (event.payload.intent) parts.push(`**Intent:** ${event.payload.intent}`);
  if (event.payload.signals?.length) parts.push(`**Signals:** ${event.payload.signals.join(', ')}`);
  parts.push('', event.payload.body || event.payload.synthesis || event.payload.reason || '');
  return parts.join('\n');
}

export async function render(slug, options = {}) {
  const { collabDir, author, dryRun = false } = options;
  const dir = collabDir || findCollabDir(slug);
  if (!dir) throw new Error(`no collab directory: ${slug}`);
  const events = readEvents(dir);

  writeFileSync(join(dir, 'STATUS.md'), buildStatusMd(events, slug));

  const turnsDir = join(dir, 'turns');
  if (!existsSync(turnsDir)) mkdirSync(turnsDir);
  for (const e of events.filter(e => e.type === 'turn')) {
    const n = e.event_id.replace('evt-', '').padStart(3, '0');
    writeFileSync(join(turnsDir, `${n}-${authorSlugFromTriplet(e.author)}.md`), buildTurnMd(e));
  }

  if (!dryRun && author) {
    const last = events[events.length - 1];
    gitCommitPush(dir, `[${author}] render: ${slug} ${last?.event_id ?? 'init'}`);
  }
}

export function main(argv) {
  const slug = argv[0];
  if (!slug) { process.stderr.write('usage: collab-render.mjs <slug>\n'); return 2; }
  render(slug).then(() => process.stdout.write(`Rendered STATUS.md + turns/ for ${slug}\n`))
    .catch(e => { process.stderr.write(`render error: ${e.message}\n`); process.exit(1); });
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
