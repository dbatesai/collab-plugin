import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  resolveTransportPaths, isGitTransport,
  defaultTickIntervalMinutes, defaultRatificationWindowMinutes,
  preflightTransport, detectHarness, parseTransport, LOCAL_COLLABS_ROOT,
} from '../skills/collab/scripts/transport.mjs';

test('LOCAL_COLLABS_ROOT resolves to ~/.collab/local/', () => {
  assert.equal(LOCAL_COLLABS_ROOT, resolve(homedir(), '.collab/local'));
});

test('parseTransport accepts localhost', () => {
  assert.deepEqual(parseTransport('localhost'), { kind: 'localhost', repo: null });
});

test('parseTransport accepts github:<repo>', () => {
  assert.deepEqual(parseTransport('github:files'), { kind: 'github', repo: 'files' });
  assert.deepEqual(parseTransport('github:bblens-handoff'), { kind: 'github', repo: 'bblens-handoff' });
});

test('parseTransport rejects garbage', () => {
  assert.equal(parseTransport(''), null);
  assert.equal(parseTransport('github:'), null);
  assert.equal(parseTransport('github:UPPER'), null);
  assert.equal(parseTransport('mcp:foo'), null);
});

test('isGitTransport distinguishes localhost from github', () => {
  assert.equal(isGitTransport('localhost'), false);
  assert.equal(isGitTransport('github:files'), true);
});

test('defaultTickIntervalMinutes returns 2 for localhost, 30 for github', () => {
  assert.equal(defaultTickIntervalMinutes('localhost'), 2);
  assert.equal(defaultTickIntervalMinutes('github:files'), 30);
});

test('defaultRatificationWindowMinutes enforces 30-min floor for localhost', () => {
  assert.equal(defaultRatificationWindowMinutes('localhost', 2), 30);  // 3*2=6 floor to 30
  assert.equal(defaultRatificationWindowMinutes('localhost', 15), 45); // 3*15=45 above floor
  assert.equal(defaultRatificationWindowMinutes('github:files', 30), 90); // no floor
  assert.equal(defaultRatificationWindowMinutes('github:files', 5), 15);  // no floor on github
});

test('resolveTransportPaths returns ~/.collab/local/<date>-<slug>/ for localhost', () => {
  const r = resolveTransportPaths('localhost', '2026-05-25-test-slug');
  assert.equal(r.collabDir, join(LOCAL_COLLABS_ROOT, '2026-05-25-test-slug'));
  assert.equal(r.eventsDir, join(LOCAL_COLLABS_ROOT, '2026-05-25-test-slug', 'events'));
});

test('resolveTransportPaths returns ~/Documents/Projects/<repo>/collabs/<date>-<slug>/ for github', () => {
  const r = resolveTransportPaths('github:files', '2026-05-25-test-slug');
  assert.equal(r.collabDir, resolve(homedir(), 'Documents/Projects/files/collabs/2026-05-25-test-slug'));
  assert.equal(r.eventsDir, resolve(homedir(), 'Documents/Projects/files/collabs/2026-05-25-test-slug', 'events'));
});

test('preflightTransport succeeds on writable directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'preflight-ok-'));
  const r = preflightTransport.__withRoot(tmp, 'localhost', '2026-05-25-test');
  assert.equal(r.ok, true, r.error || 'expected ok');
  rmSync(tmp, { recursive: true, force: true });
});

test('preflightTransport reports error on unwritable directory', () => {
  const r = preflightTransport.__withRoot('/proc/cannot-create-here', 'localhost', '2026-05-25-test');
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});

test('detectHarness defaults to claude-code with no env vars', () => {
  const saved = {
    codex: process.env.CODEX_PLUGIN_ROOT,
    gemini: process.env.GEMINI_PLUGIN_ROOT,
    override: process.env.COLLAB_HARNESS_OVERRIDE,
  };
  delete process.env.CODEX_PLUGIN_ROOT;
  delete process.env.GEMINI_PLUGIN_ROOT;
  delete process.env.COLLAB_HARNESS_OVERRIDE;
  try {
    assert.equal(detectHarness(), 'claude-code');
  } finally {
    if (saved.codex) process.env.CODEX_PLUGIN_ROOT = saved.codex;
    if (saved.gemini) process.env.GEMINI_PLUGIN_ROOT = saved.gemini;
    if (saved.override) process.env.COLLAB_HARNESS_OVERRIDE = saved.override;
  }
});

test('detectHarness picks codex when CODEX_PLUGIN_ROOT set', () => {
  const saved = process.env.CODEX_PLUGIN_ROOT;
  process.env.CODEX_PLUGIN_ROOT = '/some/path';
  try {
    assert.equal(detectHarness(), 'codex');
  } finally {
    if (saved) process.env.CODEX_PLUGIN_ROOT = saved; else delete process.env.CODEX_PLUGIN_ROOT;
  }
});

test('detectHarness picks gemini when GEMINI_PLUGIN_ROOT set (and no codex)', () => {
  const saved = { codex: process.env.CODEX_PLUGIN_ROOT, gemini: process.env.GEMINI_PLUGIN_ROOT };
  delete process.env.CODEX_PLUGIN_ROOT;
  process.env.GEMINI_PLUGIN_ROOT = '/some/path';
  try {
    assert.equal(detectHarness(), 'gemini');
  } finally {
    if (saved.codex) process.env.CODEX_PLUGIN_ROOT = saved.codex;
    if (saved.gemini) process.env.GEMINI_PLUGIN_ROOT = saved.gemini; else delete process.env.GEMINI_PLUGIN_ROOT;
  }
});

test('detectHarness honors COLLAB_HARNESS_OVERRIDE verbatim', () => {
  const saved = {
    codex: process.env.CODEX_PLUGIN_ROOT,
    gemini: process.env.GEMINI_PLUGIN_ROOT,
    override: process.env.COLLAB_HARNESS_OVERRIDE,
  };
  delete process.env.CODEX_PLUGIN_ROOT;
  delete process.env.GEMINI_PLUGIN_ROOT;
  process.env.COLLAB_HARNESS_OVERRIDE = 'custom-harness';
  try {
    assert.equal(detectHarness(), 'custom-harness');
  } finally {
    if (saved.codex) process.env.CODEX_PLUGIN_ROOT = saved.codex;
    if (saved.gemini) process.env.GEMINI_PLUGIN_ROOT = saved.gemini;
    if (saved.override) process.env.COLLAB_HARNESS_OVERRIDE = saved.override; else delete process.env.COLLAB_HARNESS_OVERRIDE;
  }
});

test('detectHarness priority: codex wins over gemini wins over override', () => {
  const saved = {
    codex: process.env.CODEX_PLUGIN_ROOT,
    override: process.env.COLLAB_HARNESS_OVERRIDE,
  };
  process.env.CODEX_PLUGIN_ROOT = '/codex/path';
  process.env.COLLAB_HARNESS_OVERRIDE = 'should-be-ignored';
  try {
    assert.equal(detectHarness(), 'codex');
  } finally {
    if (saved.codex) process.env.CODEX_PLUGIN_ROOT = saved.codex; else delete process.env.CODEX_PLUGIN_ROOT;
    if (saved.override) process.env.COLLAB_HARNESS_OVERRIDE = saved.override; else delete process.env.COLLAB_HARNESS_OVERRIDE;
  }
});
