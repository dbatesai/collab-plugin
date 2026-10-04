// A call with no --workspace-id refuses unless an identity already exists under the old
// 'unknown' default (a record, or a channel that admitted it); nothing is minted on refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const T = mkdtempSync(join(tmpdir(), 'collab-wsid-'));
process.env.COLLAB_LOCAL_ROOT = join(T, 'local');
process.env.COLLAB_IDENTITY_ROOT = join(T, 'id');
const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../skills/collab/scripts');
const { resolveIdentity, writeIdentityRecord, deriveMachine } = await import(join(SCRIPTS, 'collab-identity.mjs'));
const ids = () => (existsSync(join(T, 'id')) ? readdirSync(join(T, 'id')) : []);

test('no workspace id and no prior identity → EWORKSPACEID, nothing minted', () => {
  for (const ws of [undefined, null, '', 'unknown', '///']) {
    assert.throws(() => resolveIdentity(ws), e => e.code === 'EWORKSPACEID' && /--workspace-id/.test(e.message));
  }
  assert.deepEqual(ids(), []);
});

test('the CLIs print the refusal and exit 2, no stack trace', () => {
  const env = { ...process.env };
  for (const args of [['collab-route.mjs', 'hello'], ['collab-kickoff.mjs', 'hello', '--transport', 'localhost', '--dry-run']]) {
    const r = spawnSync(process.execPath, [join(SCRIPTS, args[0]), ...args.slice(1)], { env, encoding: 'utf8' });
    assert.match(r.stderr, /--workspace-id is required/);
    assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
    assert.notEqual(r.status, 0);
  }
  assert.deepEqual(ids(), []);
});

test('the loop CLI refuses on an existing collab too', async () => {
  const { kickoff } = await import(join(SCRIPTS, 'collab-kickoff.mjs'));
  const k = await kickoff('loop refusal probe', { workspaceId: 'ws-k', transport: 'localhost' });
  const env = { ...process.env, COLLAB_IDENTITY_ROOT: join(T, 'id-fresh') };
  const r = spawnSync(process.execPath, [join(SCRIPTS, 'collab-loop.mjs'), 'status', k.slug], { env, encoding: 'utf8' });
  assert.match(r.stderr, /--workspace-id is required/);
  assert.doesNotMatch(r.stderr, /at .*\.mjs:\d+/);
  assert.equal(r.status, 2);
  assert.ok(!existsSync(join(T, 'id-fresh')));
});

test('an explicit id mints', () => {
  assert.equal(resolveIdentity('ws-a').workspace_id, 'ws-a');
});

test('a channel that admitted the legacy unknown identity still resolves', () => {
  const author = `unknown@claude-code:${deriveMachine()}`;
  const events = [{ type: 'join', author, participant_id: 'pcp-legacy', payload: {} }];
  const r = resolveIdentity(undefined, { events });
  assert.equal(r.participant_id, 'pcp-legacy');
});

test('an install with a legacy unknown record keeps working', () => {
  writeIdentityRecord({ participant_id: 'pcp-old', triplet: 'unknown@claude-code:box', workspace_id: 'unknown', machine: 'box', harness_at_mint: 'claude-code', minted_at: '2026-01-01T00:00:00Z' });
  assert.equal(resolveIdentity(undefined).participant_id, 'pcp-old');
});

test('cleanup', () => rmSync(T, { recursive: true, force: true }));
