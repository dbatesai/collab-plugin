/**
 * test-pending-tests-fail-honestly.mjs — the guard on tests/pending/.
 *
 * tests/pending/ holds tests that are red on purpose: they pin behavior the code
 * does not have yet. A red test only carries meaning if it is red for the reason
 * it claims. A test that dies on a bad import is also "red", and looks identical
 * in a summary line — that is how a file can sit in the repo documenting a defect
 * while proving nothing about it.
 *
 * This happened. Two pending tests were committed with imports one directory
 * level short, so both died with ERR_MODULE_NOT_FOUND before a single assertion
 * ran, inside the same commit whose README said that must not happen. Review did
 * not catch it. Running them did.
 *
 * So: every file in tests/pending/ must fail, and must fail on an assertion.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const PENDING_DIR = join(TESTS_DIR, 'pending');

const pendingFiles = readdirSync(PENDING_DIR).filter((f) => f.endsWith('.mjs'));

test('tests/pending/ is not silently empty', () => {
  assert.ok(pendingFiles.length > 0,
    'no pending tests found — if the last one was resolved, delete this guard with it');
});

for (const file of pendingFiles) {
  test(`pending test ${file} fails on an assertion, not on a broken import`, () => {
    // node --test sets NODE_TEST_CONTEXT on the processes it spawns, and a runner
    // that inherits it reports to its parent instead of exiting on its own verdict
    // — so a nested run would report status 0 for a file that plainly fails. Strip
    // it, or this guard reads every pending test as passing.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;

    const res = spawnSync(process.execPath,
      ['--test', '--test-timeout=30000', join(PENDING_DIR, file)],
      { encoding: 'utf8', env });
    const output = `${res.stdout}${res.stderr}`;

    assert.notEqual(res.status, 0,
      `${file} PASSES. A pending test that passes means the gap it documents was closed — ` +
      `move it into tests/ so CI protects it, or delete it.`);

    for (const wrongReason of ['ERR_MODULE_NOT_FOUND', 'SyntaxError', 'ERR_UNKNOWN_FILE_EXTENSION']) {
      assert.ok(!output.includes(wrongReason),
        `${file} fails with ${wrongReason} — it never reached an assertion, so it proves ` +
        `nothing about the defect it claims to pin. Fix the file, do not accept the red.`);
    }

    assert.ok(output.includes('AssertionError'),
      `${file} fails without a single AssertionError, so whatever it is demonstrating is not ` +
      `the thing it asserts. Output:\n${output.slice(0, 800)}`);
  });
}
