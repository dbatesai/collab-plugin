/**
 * run-mutations.mjs — mutation controls for the eligibility v1 guarantees.
 *
 * A test that fails only because an export is missing proves the symbol is used, not that
 * the assertion detects the defect. Each entry below is a targeted change to one guarantee
 * — the smallest edit that reintroduces the failure the guarantee exists to prevent — and
 * the test files that must catch it. The script copies the tree, applies one mutation,
 * runs those files, and reports how many tests failed. A mutation that survives (zero
 * failures) fails the run.
 *
 * Not a `test-*.mjs` file on purpose: it runs the suite many times over.
 *   node tests/tools/run-mutations.mjs
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const H = 'skills/collab/scripts/collab-event-helpers.mjs';
const T = 'skills/collab/scripts/collab-tick.mjs';
const V = 'skills/collab/scripts/collab-validate.mjs';
const R = 'skills/collab/scripts/collab-render.mjs';
const K = 'skills/collab/scripts/collab-kickoff.mjs';

export const MUTATIONS = [
  { id: 'M1 legacy verdict credited before the propose-close', file: H,
    find: '} else if (proposeIdx !== -1 && i > proposeIdx) {', replace: '} else {',
    tests: ['test-collab-eligibility.mjs', 'test-collab-replay-legacy.mjs'] },
  { id: 'M2 an objection no longer blocks the close outcome', file: H,
    find: 'if (objected_measures.length === 0 && ratified_measures.length > 0) {', replace: 'if (ratified_measures.length > 0) {',
    tests: ['test-collab-eligibility.mjs', 'test-collab-eligibility-tick.mjs'] },
  { id: 'M3 a scoped verdict with a bad id gets partial credit', file: H,
    find: "if (ids.some(id => !owed.includes(id) || judged.has(`${e.author}\\n${id}`))) return; // whole-event refusal", replace: '',
    tests: ['test-collab-wait-cycle.mjs'] },
  { id: 'M4 a missing deadline is no deadline', file: H,
    find: 'return new Date(Date.parse(turn.ts) + getTickIntervalMs(events)).toISOString();', replace: 'return null;',
    tests: ['test-collab-default-deadline.mjs', 'test-collab-chase.mjs'] },
  { id: 'M5 the fallback waits for the chase sequence again (R3-H1)', file: H,
    find: 'if (!settled) due.push({ participant, action, for_deadline: dl, chases_so_far: chases });',
    replace: 'if (!settled && chases >= CHASE_FLOOD_LIMIT) due.push({ participant, action, for_deadline: dl, chases_so_far: chases });',
    tests: ['test-collab-obligations.mjs', 'test-collab-default-deadline.mjs', 'test-collab-eligibility-tick.mjs'] },
  { id: 'M6 any referencing verdict delivers a request (R3-M1)', file: H,
    find: 'if (ids && (about.length === 0 || about.some(id => ids.includes(id)))) { req.state = \'delivered\'; break; }',
    replace: 'if (true) { req.state = \'delivered\'; break; }',
    tests: ['test-collab-wait-cycle.mjs', 'test-collab-eligibility-tick.mjs'] },
  { id: 'M7 the writer gate is skipped', file: H,
    find: 'const gate = writerGateError(collabDir, event);', replace: 'const gate = null;',
    tests: ['test-collab-append-noclobber.mjs'] },
  { id: 'M8 contract-invalid never fires', file: T,
    find: 'if (errors.length && joiners.size >= 2) {', replace: 'if (false) {',
    tests: ['test-collab-eligibility-tick.mjs'] },
  { id: 'M9 the stall net ignores the contract', file: T,
    find: "const contract = net === 'stall' ? computeCloseOutcome(events, nowTs, { route: 'stall' }) : null;", replace: 'const contract = null;',
    tests: ['test-collab-eligibility-tick.mjs'] },
  { id: 'M10 the validator misses verdict-duplicate', file: V,
    find: 'else if (mine.has(id))', replace: 'else if (false)',
    tests: ['test-collab-eligibility-validate.mjs'] },
  { id: 'M11 STATUS.md drops the Measures table', file: R,
    find: 'if (verdicts.size) {', replace: 'if (false) {',
    tests: ['test-collab-render.mjs'] },
  { id: 'M12 a non-solo kickoff needs no measures', file: K,
    find: 'if (capabilitiesWanted.length && measures.length === 0) {', replace: 'if (false) {',
    tests: ['test-collab-kickoff.mjs'] },
  { id: 'M13 silence credits a measure (a required reviewer implicitly ratifies)', file: H,
    find: 'if (required.has(agent)) continue;', replace: '',
    tests: ['test-collab-peer-silence-terminal.mjs'] },
  { id: 'M14 the publisher ignores authorship — a foreign event is delivered (R3-H4)', file: H,
    find: "if (e?.event_id === base.slice(0, -5) && e?.author === author) { owned.push(path); continue; }",
    replace: "if (e?.event_id === base.slice(0, -5)) { owned.push(path); continue; }",
    tests: ['test-collab-git-delivery.mjs'] },
  { id: 'M15 the retry gate trusts a clean tree — a committed-but-unpushed record is never delivered (R3-H3)', file: H,
    find: 'if (ahead.length) {', replace: 'if (owned.length) {',
    tests: ['test-collab-git-delivery.mjs'] },
];

function runOne(m) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-mutation-'));
  try {
    cpSync(join(ROOT, 'skills'), join(dir, 'skills'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(dir, 'tests'), { recursive: true });
    const path = join(dir, m.file);
    const src = readFileSync(path, 'utf8');
    const n = src.split(m.find).length - 1;
    if (n !== 1) return { ...m, error: `find string occurs ${n} times, expected 1` };
    writeFileSync(path, src.replace(m.find, m.replace));
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...m.tests.map(t => join('tests', t))], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, COLLAB_STATE_ROOT: mkdtempSync(join(tmpdir(), 'collab-state-')) },
    });
    const out = r.stdout + r.stderr;
    const fail = Number((/^# fail (\d+)/m.exec(out) || [])[1] ?? NaN);
    const total = Number((/^# tests (\d+)/m.exec(out) || [])[1] ?? NaN);
    const names = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map(x => x[1]);
    return { ...m, fail, total, names };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let survived = 0;
  for (const m of MUTATIONS) {
    const r = runOne(m);
    if (r.error) { survived++; console.log(`ERROR    ${r.id} — ${r.error}`); continue; }
    const caught = r.fail > 0;
    if (!caught) survived++;
    console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${r.id} — ${r.fail}/${r.total} failed in ${r.tests.join(', ')}`);
    for (const n of r.names.slice(0, 4)) console.log(`           ↳ ${n}`);
  }
  console.log(survived ? `\n${survived} mutation(s) survived` : '\nevery mutation was caught');
  process.exit(survived ? 1 : 0);
}
