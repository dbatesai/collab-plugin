import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'skills', 'collab', 'scripts', 'poke-file-repo.mjs');

test('rung-2 file-repo poke adapter: self-check passes (notify-only, one fetch per check, unreachable is a reason)', () => {
  const out = execFileSync('node', [script, '--self-check'], { encoding: 'utf8' });
  assert.match(out, /self-check: PASS/);
});

test('rung-2 file-repo poke adapter: the check result never carries entry content or authority fields', async () => {
  const { check } = await import(script);
  const r = check({ lastVerifiedHead: null }, { repoDir: here, remote: 'no-such-remote', ref: 'main' });
  assert.deepEqual(Object.keys(r).sort(), ['head', 'landed', 'observedAt', 'reason', 'route']);
  assert.equal(r.landed, false);
});
