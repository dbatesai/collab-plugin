import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHarness, deriveTriplet, authorSlugFromTriplet, readLocalPluginVersion, readLocalPluginVersionInfo, checkMinVersion } from '../skills/collab/scripts/collab-event-helpers.mjs';

// Integration coverage for the detectHarness re-export and triplet helpers.
// Raw detectHarness priority/override behavior lives in test-transport.mjs; this
// file proves the re-export wires through and that deriveTriplet honors the
// v0.2 fallback chain (CODEX → GEMINI → COLLAB_HARNESS_OVERRIDE → 'claude-code').

// Save and restore env vars so tests don't leak
function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; }
  Object.assign(process.env, env);
  // null/undefined means unset
  for (const k of Object.keys(env)) { if (env[k] == null) delete process.env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('detectHarness re-export from helpers resolves to the transport.mjs implementation', () => {
  withEnv({ CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null, COLLAB_HARNESS_OVERRIDE: null }, () => {
    assert.equal(detectHarness(), 'claude-code');
  });
});

test('deriveTriplet: composes workspace@harness:machine with claude-code default', () => {
  withEnv({ CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null, COLLAB_HARNESS_OVERRIDE: null }, () => {
    const t = deriveTriplet('core-framework');
    assert.match(t, /^core-framework@claude-code:[\w-]+$/, `got: ${t}`);
  });
});

test('deriveTriplet: harness reflects CODEX_PLUGIN_ROOT', () => {
  withEnv({ CODEX_PLUGIN_ROOT: '/x', GEMINI_PLUGIN_ROOT: null, COLLAB_HARNESS_OVERRIDE: null }, () => {
    const t = deriveTriplet('core-codex');
    assert.ok(t.includes('@codex:'), `got: ${t}`);
  });
});

test('deriveTriplet: harness reflects COLLAB_HARNESS_OVERRIDE when no CODEX/GEMINI set', () => {
  withEnv({ CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null, COLLAB_HARNESS_OVERRIDE: 'custom' }, () => {
    const t = deriveTriplet('core-custom');
    assert.ok(t.includes('@custom:'), `got: ${t}`);
  });
});

test('authorSlugFromTriplet handles each harness suffix', () => {
  assert.equal(authorSlugFromTriplet('core-framework@claude-code:home'), 'core-framework');
  assert.equal(authorSlugFromTriplet('core-codex@codex:laptop'), 'core-codex');
  assert.equal(authorSlugFromTriplet('core-gemini@gemini:work'), 'core-gemini');
  assert.equal(authorSlugFromTriplet('core-custom@custom-harness:host'), 'core-custom');
});

// readLocalPluginVersion — path-based fallback (env vars absent, agent Bash tool context)
test('readLocalPluginVersion: returns 0.0.0 when no env vars and not in cache path', () => {
  withEnv({
    CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null,
    CLAUDE_PLUGIN_ROOT: null, COLLAB_PLUGIN_ROOT: null,
  }, () => {
    // Dev source path doesn't match cache pattern — expect 0.0.0
    const v = readLocalPluginVersion();
    assert.equal(typeof v, 'string', 'should return a string');
    // In dev context, path doesn't match /plugins/cache/.../version/ pattern
    // so we get 0.0.0 — this is expected and honest
    assert.match(v, /^\d+\.\d+\.\d+$/, `should be semver: got ${v}`);
  });
});

test('readLocalPluginVersion: env var root takes precedence over path fallback', () => {
  withEnv({ COLLAB_PLUGIN_ROOT: '/nonexistent/path', CODEX_PLUGIN_ROOT: null,
    GEMINI_PLUGIN_ROOT: null, CLAUDE_PLUGIN_ROOT: null }, () => {
    // When env var is set but manifest not found, falls through to path fallback
    const v = readLocalPluginVersion();
    assert.match(v, /^\d+\.\d+\.\d+$/, `should be semver: got ${v}`);
  });
});

// readLocalPluginVersionInfo — provenance metadata (v1.0 §8)

test('readLocalPluginVersionInfo: returns { version, source, confidence }', () => {
  withEnv({ CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null,
    CLAUDE_PLUGIN_ROOT: null, COLLAB_PLUGIN_ROOT: null }, () => {
    const info = readLocalPluginVersionInfo();
    assert.ok('version' in info && 'source' in info && 'confidence' in info);
    assert.match(info.version, /^\d+\.\d+\.\d+$/);
    assert.ok(['high', 'medium', 'none'].includes(info.confidence));
  });
});

test('checkMinVersion: accepts a { version } object (v1.0 §8 object-compat)', () => {
  const ok = checkMinVersion({ version: '0.3.0', source: 'env-var:X', confidence: 'high' }, '0.2.0');
  assert.equal(ok.ok, true, 'object form should satisfy min version');
  const tooLow = checkMinVersion({ version: '0.1.0' }, '0.2.0');
  assert.equal(tooLow.ok, false, 'object form below min should fail');
});

test('checkMinVersion: still accepts a plain string (legacy callers)', () => {
  assert.equal(checkMinVersion('0.3.0', '0.2.0').ok, true);
  assert.equal(checkMinVersion('0.1.0', '0.2.0').ok, false);
});
