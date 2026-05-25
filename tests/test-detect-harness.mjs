import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHarness, deriveTriplet, authorSlugFromTriplet } from '../skills/collab/scripts/collab-event-helpers.mjs';

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

test('detectHarness: CLAUDE_PLUGIN_ROOT set → claude-code', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: '/some/path', CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null }, () => {
    assert.equal(detectHarness(), 'claude-code');
  });
});

test('detectHarness: CODEX_PLUGIN_ROOT set → codex', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: null, CODEX_PLUGIN_ROOT: '/some/path', GEMINI_PLUGIN_ROOT: null }, () => {
    assert.equal(detectHarness(), 'codex');
  });
});

test('detectHarness: GEMINI_PLUGIN_ROOT set → gemini', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: null, CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: '/some/path' }, () => {
    assert.equal(detectHarness(), 'gemini');
  });
});

test('detectHarness: no env vars → claude-code (default)', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: null, CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null }, () => {
    assert.equal(detectHarness(), 'claude-code');
  });
});

test('detectHarness: claude takes precedence over codex when both set', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: '/c', CODEX_PLUGIN_ROOT: '/x', GEMINI_PLUGIN_ROOT: null }, () => {
    assert.equal(detectHarness(), 'claude-code');
  });
});

test('deriveTriplet: composes workspace@harness:machine', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: '/c', CODEX_PLUGIN_ROOT: null, GEMINI_PLUGIN_ROOT: null }, () => {
    const t = deriveTriplet('core-framework');
    assert.match(t, /^core-framework@claude-code:[\w-]+$/, `got: ${t}`);
  });
});

test('deriveTriplet: harness reflected from env', () => {
  withEnv({ CLAUDE_PLUGIN_ROOT: null, CODEX_PLUGIN_ROOT: '/x', GEMINI_PLUGIN_ROOT: null }, () => {
    const t = deriveTriplet('core-codex');
    assert.ok(t.includes('@codex:'), `got: ${t}`);
  });
});

test('authorSlugFromTriplet handles each harness suffix', () => {
  assert.equal(authorSlugFromTriplet('core-framework@claude-code:home'), 'core-framework');
  assert.equal(authorSlugFromTriplet('core-codex@codex:laptop'), 'core-codex');
  assert.equal(authorSlugFromTriplet('core-gemini@gemini:work'), 'core-gemini');
});
