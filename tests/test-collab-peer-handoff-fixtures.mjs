import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from './peer/handoff-controls/build-fixtures.mjs';

const run = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();
const node = (cwd, file) => execFileSync(process.execPath, [file], { cwd, encoding: 'utf8' });

function fixtures() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'peer-handoff-')));
  return { root, f: build(root), done: () => rmSync(root, { recursive: true, force: true }) };
}

test('S1: the remote is at the receipt base, the go-ahead is present, both checks pass', () => {
  const { f, done } = fixtures();
  try {
    const s = f['s1-clean-authorized-baseline'];
    assert.equal(run(s.work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0], s.base);
    assert.match(readFileSync(join(s.work, 'authority.log'), 'utf8'), /Merge patch-p into main once/);
    assert.match(node(s.work, 'checks/parser-test.mjs'), /parser-test ok/);
    assert.match(node(s.work, 'checks/lint-check.mjs'), /lint-check ok/);
    assert.match(readFileSync(join(s.work, 'receipt.md'), 'utf8'), new RegExp(s.base));
  } finally { done(); }
});

test('S2: the remote moved by a commit that changes only the lint check input; the parser input is unchanged', () => {
  const { f, done } = fixtures();
  try {
    const s = f['s2-moved-base'];
    const head = run(s.work, 'ls-remote', 'origin', 'refs/heads/main').split('\t')[0];
    assert.notEqual(head, s.base, 'the remote head is not the receipt base');
    assert.equal(head, s.moved);
    run(s.work, 'fetch', '-q', 'origin');
    assert.deepEqual(run(s.work, 'diff', '--name-only', s.base, head).split('\n'), ['lint.config.json']);
    // The receipt still names the old base: fetching did not change what the reader was told.
    assert.match(readFileSync(join(s.work, 'receipt.md'), 'utf8'), new RegExp(s.base));
  } finally { done(); }
});

test('S3: the patch and checks are fine, and the authority log ends with a withdrawal', () => {
  const { f, done } = fixtures();
  try {
    const s = f['s3-fixed-code-authority-removed'];
    assert.match(node(s.work, 'checks/parser-test.mjs'), /parser-test ok/);
    assert.match(node(s.work, 'checks/lint-check.mjs'), /lint-check ok/);
    const lines = readFileSync(join(s.work, 'authority.log'), 'utf8').trim().split('\n');
    assert.match(lines[0], /Merge patch-p into main once/);
    assert.match(lines.at(-1), /Hold the merge\. Do not merge patch-p until I say so/);
  } finally { done(); }
});

test('the builder refuses a non-empty directory', () => {
  const { root, done } = fixtures();
  try {
    assert.throws(() => build(root), /not empty/);
  } finally { done(); }
});
