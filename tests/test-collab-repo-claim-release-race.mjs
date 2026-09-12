/**
 * test-collab-repo-claim-release-race.mjs — contending for the repo claim must
 * never crash the contender.
 *
 * `acquireRepoClaim` checks `existsSync(claimPath)` and then reads `statSync`
 * on the same path. Between those two calls the current holder can release,
 * which is ordinary behavior, not an error — releasing is what holders do. The
 * read of the claim body is inside a try/catch; the stat is not, so a contender
 * that arrives in that window dies on an uncaught ENOENT.
 *
 * The existing repo-lock tests cannot see this: all of them are single-process
 * and sequential, so nothing ever releases while another caller is mid-check.
 *
 * This is the primitive that guards `gitPullRebase` and `gitCommitPush`, so on a
 * shared worktree two same-machine agents can kill each other mid-cycle — the
 * exact hazard failure class 24 exists to rule out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

const HELPERS = join(dirname(fileURLToPath(import.meta.url)),
  '..', 'skills', 'collab', 'scripts', 'collab-event-helpers.mjs');

const WORKERS = 8;
const ROUNDS = 30;

// Each worker hammers acquire/release. A worker that loses the claim is fine and
// expected; a worker that THROWS is the defect. The child reports by exit code.
// Each worker waits on a start file, so all eight are inside acquire/release at
// the same time. Sequential spawns never contend and the test would pass
// vacuously — the first draft of this file did exactly that.
const WORKER = `
import { existsSync } from 'node:fs';
import { acquireRepoClaim, releaseRepoClaim } from ${JSON.stringify(HELPERS)};
const [repo, owner, rounds, gate] = process.argv.slice(2);
while (!existsSync(gate)) { /* spin to the barrier */ }
for (let i = 0; i < Number(rounds); i++) {
  const claim = acquireRepoClaim(repo, owner);
  if (claim) releaseRepoClaim(repo, claim);
}
`;

test('a holder releasing mid-check does not crash the contender', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-claim-race-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const workerPath = join(dir, 'worker.mjs');
  const gate = join(dir, 'GO');
  writeFileSync(workerPath, WORKER);

  try {
    const done = [];
    for (let w = 0; w < WORKERS; w++) {
      const kid = spawn(process.execPath, [workerPath, repo, `owner-${w}`, String(ROUNDS), gate],
        { encoding: 'utf8' });
      let stderr = '';
      kid.stderr.on('data', (d) => { stderr += d; });
      done.push(new Promise((resolve) => kid.on('close', (status) => resolve({ w, status, stderr }))));
    }

    writeFileSync(gate, 'go');           // release all eight at once
    const results = await Promise.all(done);
    const crashed = results.filter((r) => r.status !== 0);

    assert.deepEqual(crashed.map((c) => c.w), [],
      `${crashed.length} of ${WORKERS} contenders crashed instead of losing the claim ` +
      `cleanly. Losing is normal; throwing is the defect. First:\n${crashed[0]?.stderr.slice(0, 600)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
