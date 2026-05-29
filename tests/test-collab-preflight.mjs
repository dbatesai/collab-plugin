import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runPreflight, PREFLIGHT_CODES } from '../skills/collab/scripts/collab-preflight.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive the actual scripts/ dir from the test file's location
const SCRIPTS_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'skills', 'collab', 'scripts');
const PREFLIGHT_SCRIPT = resolve(SCRIPTS_DIR, 'collab-preflight.mjs');

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
  // Use the real live slug which we know exists
  const res = runPreflight({
    slug: 'keel-hk-here-starting-a-new-session-fresh-collab',
    isNewCollab: true, justification: 'adversarial-review',
    selfPath: PREFLIGHT_SCRIPT,
  });
  const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.SLUG_COLLISION);
  assert.ok(b, 'existing slug should block a new-collab kickoff');
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
  // The live collab dir should be writable (we've been writing to it all session)
  const res = runPreflight({
    slug: 'keel-hk-here-starting-a-new-session-fresh-collab',
    selfPath: PREFLIGHT_SCRIPT,
    // Skip git checks to isolate the write test
    _env: { GIT_TERMINAL_PROMPT: '0' },
  });
  const writeBlocker = res.blockers.find(b => b.code === PREFLIGHT_CODES.LOCAL_WRITE_FAILED);
  assert.ok(!writeBlocker, 'live collab dir should pass local write test');
});

// --- version check integration ---

test('preflight #2: version blocker when required version too high', () => {
  const res = runPreflight({
    slug: 'keel-hk-here-starting-a-new-session-fresh-collab',
    minVersion: '999.0.0', selfPath: PREFLIGHT_SCRIPT,
  });
  const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.VERSION_TOO_LOW);
  assert.ok(b, 'unreachable min version should block');
  assert.equal(res.pass, false);
});

test('preflight #2: version passes when min is satisfied (uses dev-context: 0.0.0 >= 0.0.0)', () => {
  // In dev-source context, readLocalPluginVersionInfo() returns {version:'0.0.0'} (no cache path).
  // Use minVersion '0.0.0' to prove the logic works. The cache-path fallback is tested separately
  // in test-detect-harness.mjs (it correctly extracts the version from the installed cache path).
  const res = runPreflight({
    slug: 'keel-hk-here-starting-a-new-session-fresh-collab',
    minVersion: '0.0.0', selfPath: PREFLIGHT_SCRIPT,
  });
  const b = res.blockers.find(b => b.code === PREFLIGHT_CODES.VERSION_TOO_LOW);
  assert.ok(!b, 'min version 0.0.0 should be satisfied by dev-source install');
});
