import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMinVersion } from '../skills/collab/scripts/collab-event-helpers.mjs';

test('checkMinVersion passes when local >= min', () => {
  assert.equal(checkMinVersion('0.2.0', '0.2.0').ok, true);
  assert.equal(checkMinVersion('0.2.1', '0.2.0').ok, true);
  assert.equal(checkMinVersion('1.0.0', '0.2.0').ok, true);
});

test('checkMinVersion fails when local < min', () => {
  const r = checkMinVersion('0.1.4', '0.2.0');
  assert.equal(r.ok, false);
  assert.match(r.error, /requires collab-plugin/);
  assert.match(r.error, /0\.2\.0/);
  assert.match(r.error, /0\.1\.4/);
});

test('checkMinVersion passes when min is undefined or null (v0.1.x compat)', () => {
  assert.equal(checkMinVersion('0.1.4', undefined).ok, true);
  assert.equal(checkMinVersion('0.1.4', null).ok, true);
  assert.equal(checkMinVersion('0.1.4', '').ok, true);
});

test('readLocalPluginVersion walks env var chain for each harness manifest', async () => {
  const { readLocalPluginVersion } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const saved = {
    codex: process.env.CODEX_PLUGIN_ROOT,
    gemini: process.env.GEMINI_PLUGIN_ROOT,
    claude: process.env.CLAUDE_PLUGIN_ROOT,
    collab: process.env.COLLAB_PLUGIN_ROOT,
  };
  delete process.env.CODEX_PLUGIN_ROOT;
  delete process.env.GEMINI_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.COLLAB_PLUGIN_ROOT;

  // Codex env var → reads .codex-plugin/plugin.json
  const codexRoot = mkdtempSync(join(tmpdir(), 'codex-root-'));
  mkdirSync(join(codexRoot, '.codex-plugin'));
  writeFileSync(join(codexRoot, '.codex-plugin', 'plugin.json'), JSON.stringify({ version: '0.2.0' }));
  process.env.CODEX_PLUGIN_ROOT = codexRoot;
  try {
    assert.equal(readLocalPluginVersion(), '0.2.0');
  } finally {
    delete process.env.CODEX_PLUGIN_ROOT;
    rmSync(codexRoot, { recursive: true, force: true });
  }

  // Restore
  if (saved.codex) process.env.CODEX_PLUGIN_ROOT = saved.codex;
  if (saved.gemini) process.env.GEMINI_PLUGIN_ROOT = saved.gemini;
  if (saved.claude) process.env.CLAUDE_PLUGIN_ROOT = saved.claude;
  if (saved.collab) process.env.COLLAB_PLUGIN_ROOT = saved.collab;
});

test('readLocalPluginVersion returns 0.0.0 when no env var resolves', async () => {
  const { readLocalPluginVersion } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  const saved = {
    codex: process.env.CODEX_PLUGIN_ROOT,
    gemini: process.env.GEMINI_PLUGIN_ROOT,
    claude: process.env.CLAUDE_PLUGIN_ROOT,
    collab: process.env.COLLAB_PLUGIN_ROOT,
  };
  delete process.env.CODEX_PLUGIN_ROOT;
  delete process.env.GEMINI_PLUGIN_ROOT;
  delete process.env.CLAUDE_PLUGIN_ROOT;
  delete process.env.COLLAB_PLUGIN_ROOT;
  try {
    assert.equal(readLocalPluginVersion(), '0.0.0');
  } finally {
    if (saved.codex) process.env.CODEX_PLUGIN_ROOT = saved.codex;
    if (saved.gemini) process.env.GEMINI_PLUGIN_ROOT = saved.gemini;
    if (saved.claude) process.env.CLAUDE_PLUGIN_ROOT = saved.claude;
    if (saved.collab) process.env.COLLAB_PLUGIN_ROOT = saved.collab;
  }
});
