// Child process for the anchor concurrency controls: waits for a start file, then appends.
// argv: <collab-dir> <start-file> <mode> <event-json|count>
//   mode `one`  — append the given event (JSON) once, print the result
//   mode `many` — append <count> large events authored by this pid
import { existsSync } from 'node:fs';
import { appendEvent } from '../../skills/collab/scripts/collab-event-helpers.mjs';

const [dir, start, mode, arg] = process.argv.slice(2);
while (!existsSync(start)) { /* spin until every worker is ready */ }
if (mode === 'one') {
  process.stdout.write(JSON.stringify(appendEvent(dir, JSON.parse(arg))) + '\n');
} else {
  const pad = 'x'.repeat(64 * 1024);
  for (let i = 0; i < Number(arg); i++) {
    const ts = new Date(Date.UTC(2026, 9, 4, 0, 0, 0, i)).toISOString();
    appendEvent(dir, { event_id: `evt-big-${process.pid}-${String(i).padStart(4, '0')}`, ts, author: 'w@claude-code:h', slug: 's', type: 'note', references: [], payload: { pad } });
  }
}
