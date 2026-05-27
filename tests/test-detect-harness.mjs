import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHarness, deriveTriplet, authorSlugFromTriplet } from '../skills/collab/scripts/collab-event-helpers.mjs';

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
