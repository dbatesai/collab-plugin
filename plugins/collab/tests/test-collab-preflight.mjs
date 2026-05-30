import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight, PREFLIGHT_CODES } from '../skills/collab/scripts/collab-preflight.mjs';
import { appendEvent } from '../skills/collab/scripts/collab-event-helpers.mjs';
import { LOCAL_COLLABS_ROOT } from '../skills/collab/scripts/transport.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive the actual scripts/ dir from the test file's location
const SCRIPTS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'skills', 'collab', 'scripts');
const PREFLIGHT_SCRIPT = resolve(SCRIPTS_DIR, 'collab-preflight.mjs');

function makeLocalCollabFixture(slug) {
  const dirName = `2026-05-25-${slug}`;
  const dir = join(LOCAL_COLLABS_ROOT, dirName);
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, {
    event_id: 'evt-001',
    ts: '2026-05-25T09:22:00Z',
    author: 'fixture@claude-code:test',
    slug,
    type: 'kickoff',
    references: [],
    payload: { transport: 'localhost' },
  });
  return dir;
}

// --- 1. Entrypoint check ---

test('preflight #1: entrypoint PASS when sibling collab-tick.mjs exists in script dir', () => {
  // Pass the real preflight script path (not the test file path) so dirname resolves to scripts/
  const res = runPreflight({ slug: 'nonexistent-slug-for-test', selfPath: PREFLIGHT_SCRIPT });
  const entrypointBlocker = res.blockers.find(b => b.code === PREFLIGHT_CODES.ENTRYPOINT_MISMATCH);
  assert.ok(!entrypointBlocker, 'no entrypoint mismatch when tick.mjs is beside preflight.mjs');
});

test('preflight #1: entrypoint BLOCKER when sibling is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-ep-'));
  try {
    const res = runPreflight({ slug: 'x', selfPath: join(tmp, 'collab-preflight.mjs') });
    const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.ENTRYPOINT_MISMATCH);
    assert.ok(b, 'missing sibling should block with ENTRYPOINT_MISMATCH');
    assert.equal(res.pass, false);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// --- 3. Route dry-run / slug checks ---

test('preflight #3: missing slug blocks when not a new collab', () => {
  const res = runPreflight({ slug: 'definitely-does-not-exist-slug-99999', selfPath: PREFLIGHT_SCRIPT });
  const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.SLUG_NOT_FOUND);
  assert.ok(b, 'missing slug should block when not isNewCollab');
});

test('preflight: new collab with existing slug blocks (collision)', () => {
  const slug = `preflight-collision-${Date.now()}`;
  const dir = makeLocalCollabFixture(slug);
  try {
    const res = runPreflight({
      slug,
      isNewCollab: true,
      justification: 'adversarial-review',
      selfPath: PREFLIGHT_SCRIPT,
    });
    const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.SLUG_COLLISION);
    assert.ok(b, 'existing synthetic fixture slug should block a new-collab kickoff');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- justification gate ---

test('preflight: new collab without justification blocks', () => {
  const res = runPreflight({ slug: 'new-unique-slug-for-test-only', isNewCollab: true, selfPath: PREFLIGHT_SCRIPT });
  const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.MISSING_JUSTIFICATION);
  assert.ok(b, 'missing justification should block new multi-agent collab');
});

test('preflight: new collab with justification only checks slug + justification (no dir yet)', () => {
  const res = runPreflight({
    slug: 'new-unique-slug-for-test-only',
    isNewCollab: true, justification: 'adversarial-review',
    selfPath: PREFLIGHT_SCRIPT,
  });
  // Only non-existence of justification blocker matters (slug is not-found → should NOT block for new)
  const justBlocker = res.blockers.find(b => b.code === PREFLIGHT_CODES.MISSING_JUSTIFICATION);
  assert.ok(!justBlocker, 'justification provided should remove that blocker');
  const slugBlocker = res.blockers.find(b => b.code === PREFLIGHT_CODES.SLUG_COLLISION);
  assert.ok(!slugBlocker, 'non-existent slug should not collide for new collab');
});

// --- 4. Local write test ---

test('preflight #4: local write PASS for existing collab dir', () => {
  const slug = `preflight-write-${Date.now()}`;
  const dir = makeLocalCollabFixture(slug);
  try {
    const res = runPreflight({ slug, selfPath: PREFLIGHT_SCRIPT });
    assert.equal(res.pass, true, JSON.stringify(res, null, 2));
    assert.ok(!res.blockers.find(b => b.code === PREFLIGHT_CODES.SLUG_NOT_FOUND), 'fixture slug should be found');
    assert.ok(!res.blockers.find(b => b.code === PREFLIGHT_CODES.LOCAL_WRITE_FAILED), 'fixture dir should pass local write');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- version check integration ---

test('preflight #2: version blocker when required version too high', () => {
  const slug = `preflight-version-high-${Date.now()}`;
  const dir = makeLocalCollabFixture(slug);
  try {
    const res = runPreflight({
      slug,
      minVersion: '999.0.0',
      selfPath: PREFLIGHT_SCRIPT,
    });
    const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.VERSION_TOO_LOW);
    assert.ok(b, 'unreachable min version should block');
    assert.equal(res.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight #2: version passes when min is satisfied (uses dev-context: 0.0.0 >= 0.0.0)', () => {
  // In dev-source context, readLocalPluginVersionInfo() returns {version:'0.0.0'} (no cache path).
  // Use minVersion '0.0.0' to prove the logic works. The cache-path fallback is tested separately
  // in test-detect-harness.mjs (it correctly extracts the version from the installed cache path).
  const slug = `preflight-version-ok-${Date.now()}`;
  const dir = makeLocalCollabFixture(slug);
  try {
    const res = runPreflight({
      slug,
      minVersion: '0.0.0',
      selfPath: PREFLIGHT_SCRIPT,
    });
    const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.VERSION_TOO_LOW);
    assert.ok(!b, 'min version 0.0.0 should be satisfied by dev-source install');
    assert.equal(res.pass, true, JSON.stringify(res, null, 2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
