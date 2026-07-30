/**
 * collab-list.mjs — list collabs across all transports.
 * CLI: node collab-list.mjs [localhost|github:<repo>] [--closed | --all]
 */
import { realpathSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localCollabsRoot, githubReposRoot, collabsRootForTransport } from './transport.mjs';
import { readEvents, isClosed, getJoinedAgents } from './collab-event-helpers.mjs';

function discoverTransports(only) {
  if (only) return [only];
  const transports = [];
  if (existsSync(localCollabsRoot())) transports.push('localhost');
  const REPOS_ROOT = githubReposRoot();
  if (existsSync(REPOS_ROOT)) {
    for (const e of readdirSync(REPOS_ROOT, { withFileTypes: true })) {
      if (existsSync(join(REPOS_ROOT, e.name, 'collabs'))) transports.push(`github:${e.name}`);
    }
  }
  return transports;
}

export function listCollabs(opts = {}) {
  const { only = null, filter = 'active' } = opts;
  const transports = discoverTransports(only);
  const rows = [];
  for (const transport of transports) {
    const root = collabsRootForTransport(transport);
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = join(root, e.name);
      const events = readEvents(dir);
      if (events.length === 0) continue;
      const closed = isClosed(events);
      if (filter === 'active' && closed) continue;
      if (filter === 'closed' && !closed) continue;
      const slug = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      const participants = getJoinedAgents(events).length;
      const startedTs = events[0].ts;
      const ageDays = Math.floor((Date.now() - new Date(startedTs).getTime()) / 86400000);
      rows.push({ transport, slug, dirName: e.name, age: `${ageDays}d`, participants, state: closed ? 'closed' : 'active' });
    }
  }
  return rows;
}

export function formatRowsAsTable(rows) {
  if (rows.length === 0) return '(no collabs found)\n';
  const header = ['transport', 'slug', 'age', 'participants', 'state'];
  const cellValues = rows.map(r => [r.transport, r.slug, r.age, String(r.participants), r.state]);
  const widths = header.map((h, i) => Math.max(h.length, ...cellValues.map(row => String(row[i] ?? '').length)));
  const fmt = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  const lines = [
    fmt(header),
    fmt(widths.map(w => '-'.repeat(w))),
    ...cellValues.map(row => fmt(row)),
  ];
  return lines.join('\n') + '\n';
}

export function main(argv) {
  let only = null, filter = 'active';
  for (const a of argv) {
    if (a === '--closed') filter = 'closed';
    else if (a === '--all') filter = 'all';
    else if (a.startsWith('localhost') || a.startsWith('github:')) only = a;
  }
  process.stdout.write(formatRowsAsTable(listCollabs({ only, filter })));
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
