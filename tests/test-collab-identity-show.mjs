// collab-identity --show: the read-only lookup another plugin uses. It never mints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../skills/collab/scripts/collab-identity.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'collab-idshow-'));
const env = { ...process.env, COLLAB_LOCAL_ROOT: join(ROOT, 'local'), COLLAB_IDENTITY_ROOT: join(ROOT, 'identity') };
const show = (ws) => spawnSync(process.execPath, [CLI, '--show', ws], { env, encoding: 'utf8' });

test('no record: exit 3, nothing minted', () => {
  const r = show('proj-abc');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /no identity record/);
  assert.equal(existsSync(join(ROOT, 'identity')) && readdirSync(join(ROOT, 'identity')).length, false, 'no identity file created');
});

test('a persisted record is printed exactly; a malformed one exits 4', () => {
  mkdirSync(join(ROOT, 'identity'), { recursive: true });
  writeFileSync(join(ROOT, 'identity', 'proj-ok.json'), JSON.stringify({ workspace_id: 'proj-ok', triplet: 'proj-ok@claude-code:h', participant_id: 'p-123' }));
  const r = show('proj-ok');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { workspace_id: 'proj-ok', triplet: 'proj-ok@claude-code:h', participant_id: 'p-123' });
  writeFileSync(join(ROOT, 'identity', 'proj-bad.json'), '{"triplet": 5');
  assert.equal(show('proj-bad').status, 4);
  writeFileSync(join(ROOT, 'identity', 'proj-shape.json'), JSON.stringify({ triplet: 'x' }));
  assert.equal(show('proj-shape').status, 4);
});

test('cleanup', () => { rmSync(ROOT, { recursive: true, force: true }); });
