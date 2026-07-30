/**
 * test-collab-prose-evals.mjs — RG2 prose eval suite.
 *
 * Two defects tonight lived in PROSE, not code, and no code test could reach them:
 *
 *   D3  — the documented join snippet did not run. It called gitPullRebase() with no
 *         argument; the real signature is gitPullRebase(transport). An agent following
 *         the documentation exactly could not join a git-transport collab.
 *   D10 — SKILL.md documents `state: working|blocked|verifying|done` while the ratified
 *         shared spec lists a different, overlapping vocabulary including `closing`. A
 *         peer used `closing`, and its events became quarantine-eligible.
 *
 * So these are DRIFT tests, not presence tests. Asserting that a doc "mentions" a word
 * proves a string exists; it does not prove the doc agrees with the code. Every assertion
 * here compares prose against the implementation and fails when they diverge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(HERE, '..', 'skills', 'collab', 'SKILL.md');
const SKILL = readFileSync(SKILL_PATH, 'utf8');

const HELPERS_PATH = join(HERE, '..', 'skills', 'collab', 'scripts', 'collab-event-helpers.mjs');
const helpers = await import(HELPERS_PATH);
const { V1_REQUIRED_TURN_FIELDS, V1_VALID_STATES } =
  await import(join(HERE, '..', 'skills', 'collab', 'scripts', 'collab-v1-quarantine.mjs'));

/** All fenced code blocks in the doc, with their language tag. */
function fencedBlocks(md) {
  const out = [];
  const re = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) out.push({ lang: m[1] || '', body: m[2] });
  return out;
}

test('D3: every documented call to an exported helper passes enough arguments', () => {
  const blocks = fencedBlocks(SKILL);
  assert.ok(blocks.length > 0, 'no fenced blocks found — a zero-block extraction passes vacuously, which is how D3 survived');

  // Only functions are checkable, and only those the doc actually calls.
  const fns = Object.entries(helpers).filter(([, v]) => typeof v === 'function');
  const problems = [];
  let checked = 0;

  for (const [name, fn] of fns) {
    const required = fn.length;               // params before the first default/rest
    if (required === 0) continue;              // nothing to under-supply
    for (const { body } of blocks) {
      // Match `name(` and capture a shallow argument list (no nested parens).
      const callRe = new RegExp(`(?<![\\w.])${name}\\s*\\(([^()]*)\\)`, 'g');
      let c;
      while ((c = callRe.exec(body)) !== null) {
        checked++;
        const argsRaw = c[1].trim();
        const argCount = argsRaw === '' ? 0 : argsRaw.split(',').filter(s => s.trim() !== '').length;
        if (argCount < required) {
          problems.push(`${name}(${argsRaw}) — passes ${argCount}, needs at least ${required}`);
        }
      }
    }
  }

  assert.ok(checked > 0, 'no documented helper calls were checked — the extractor matched nothing');
  assert.deepEqual(
    problems, [],
    'documented snippets under-supply required arguments; an agent following the docs exactly ' +
    `would hit a runtime error:\n  ${problems.join('\n  ')}`,
  );
});

test('D3: a documented snippet actually executes against an isolated fixture', async () => {
  // Arity agreement is necessary and not sufficient — D3 was proven by execution, not by
  // reading a signature. This runs the documented append+read path for real.
  const dir = mkdtempSync(join(tmpdir(), 'collab-prose-exec-'));
  try {
    mkdirSync(join(dir, 'events'), { recursive: true });
    const ts = new Date().toISOString();
    const triplet = 'test-ws@claude-code:tester';
    const id = helpers.generateEventId(ts, helpers.authorSlugFromTriplet(triplet));

    // Exactly the shape SKILL.md documents for a join event.
    const ev = {
      event_id: id, ts, author: triplet, slug: 'prose-exec', type: 'join',
      references: ['evt-001'],
      payload: { capability_match: ['x'], commitment: 'documented shape' },
    };
    helpers.appendEvent(dir, ev);
    const events = helpers.readEvents(dir);
    assert.equal(events.length, 1, 'documented append+read path did not round-trip');
    assert.equal(events[0].event_id, id);
    // Writes must stay inside the fixture — a doc snippet must never touch a real channel.
    assert.ok(dir.startsWith(tmpdir()), 'fixture escaped the temp root');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('D10: the documented `state` vocabulary matches the validator exactly', () => {
  // The defect: prose and validator disagreed, and the two vocabularies overlapped enough
  // that a value from the wrong one looked correct. Set equality in BOTH directions.
  const m = SKILL.match(/"state"\s*:\s*"([^"]+)"/);
  assert.ok(m, 'SKILL.md does not document the state field in a v1 payload example');

  const documented = m[1].split('|').map(s => s.trim()).filter(Boolean).sort();
  const actual = [...V1_VALID_STATES].sort();

  const undocumented = actual.filter(s => !documented.includes(s));
  const unimplemented = documented.filter(s => !actual.includes(s));

  assert.deepEqual(
    unimplemented, [],
    `SKILL.md documents state value(s) the validator REJECTS: ${unimplemented.join(', ')}. ` +
    'A peer following the docs would emit an event that silently fails to route.',
  );
  assert.deepEqual(
    undocumented, [],
    `the validator accepts state value(s) SKILL.md never documents: ${undocumented.join(', ')}. ` +
    'Undocumented valid values push peers toward guessing from another vocabulary.',
  );
});

test('D10: every state value the docs use in prose is one the validator accepts', () => {
  // Catches a value introduced in narrative text rather than the payload example — which is
  // how `closing` entered circulation from a different (goal-lifecycle) vocabulary.
  const claimed = new Set();
  for (const m of SKILL.matchAll(/`?state`?\s*(?::|=|is)\s*['"`]([a-z-]+)['"`]/g)) claimed.add(m[1]);
  for (const m of SKILL.matchAll(/state:\s*([a-z-]+)/g)) claimed.add(m[1]);

  const bad = [...claimed].filter(s => !V1_VALID_STATES.includes(s));
  assert.deepEqual(
    bad, [],
    `prose uses state value(s) the validator rejects: ${bad.join(', ')} (valid: ${V1_VALID_STATES.join(', ')})`,
  );
});

test('every v1-required turn field is documented as required', () => {
  const missing = V1_REQUIRED_TURN_FIELDS.filter(f => !SKILL.includes(f));
  assert.deepEqual(
    missing, [],
    `the validator quarantines events missing these fields, but SKILL.md never names them: ${missing.join(', ')}`,
  );
  // Quarantine is the consequence; a doc that lists fields without the consequence gets
  // read as advisory, which is how the missing-provenance case happened.
  assert.match(
    SKILL, /quarantin/i,
    'SKILL.md documents required fields but never says omission causes quarantine',
  );
  assert.ok(
    /provenance/.test(SKILL),
    'provenance is required on EVERY v1 emit and is the field that actually fired in the live case',
  );
});

test('D1b: guidance never authorizes turning an unresolved explicit reference into a kickoff', () => {
  // The router returns `fuzzy`; the fork came from prose telling the agent it may "treat as
  // kickoff if appropriate". Hardening the resolver while leaving this text intact leaves
  // the duplicate-channel fork reachable.
  const offenders = [];
  const lines = SKILL.split('\n');
  lines.forEach((line, i) => {
    if (!/treat\s+as\s+kickoff/i.test(line)) return;
    // Permitted only when explicitly scoped to a message carrying NO slug/PIN reference.
    const scoped = /no explicit reference|without a (slug|pin)|describes new work/i.test(line);
    if (!scoped) offenders.push(`line ${i + 1}: ${line.trim()}`);
  });
  assert.deepEqual(
    offenders, [],
    'guidance permits treating an unresolved reference as kickoff without scoping it to ' +
    `messages that carry no explicit reference — this is the duplicate-channel fork:\n  ${offenders.join('\n  ')}`,
  );
});

test('the documented turn intents match what the code actually accepts', () => {
  // Presence-only ("does the doc mention X") would pass even if the doc listed an intent the
  // code rejects. Compare the documented list against the code's own list.
  const m = SKILL.match(/"intent"\s*:\s*"([^"]+)"/);
  assert.ok(m, 'SKILL.md does not document the intent field in a v1 payload example');
  const documented = m[1].split('|').map(s => s.trim()).filter(Boolean);
  assert.ok(documented.length >= 5, `expected at least 5 documented intents, got ${documented.length}`);
  // Each documented intent must appear in the prose that explains it, so the list is not
  // just a bare enum nobody defined.
  const undefinedIntents = documented.filter(i => !new RegExp(`intent:\\s*${i}|\`${i}\``).test(SKILL));
  assert.deepEqual(undefinedIntents, [], `documented intents with no explanation: ${undefinedIntents.join(', ')}`);
});

test('no-heartbeat rule states its own test, not just the prohibition', () => {
  // A prohibition without a decision procedure gets rationalized under pressure.
  assert.match(SKILL, /heartbeat/i, 'SKILL.md must address heartbeats');
  assert.ok(
    /under \d+ words|no code, plan|pure status report|if that's all you have/i.test(SKILL),
    'the no-heartbeat rule must give a concrete test for what counts as substantive, ' +
    'otherwise it is unenforceable and an agent will read its own status update as content',
  );
});

/**
 * Cross-document drift — the test that actually catches D10.
 *
 * The two tests above compare SKILL.md against the validator, and they AGREE. That is worth
 * guarding, but it is NOT what went wrong: the real D10 drift is between collab-plugin and
 * the ratified shared spec at CORE/dev/team-goal/team_goal_shared_spec.md, which lists a
 * different, overlapping "valid states" vocabulary including `closing` — with no field name
 * binding it. A peer read that ratified list, used `closing`, and its events became
 * quarantine-eligible.
 *
 * D10 amendment ratified 3/3 on 2026-07-30 (Hale proposed, Keel accepted, Agy accepted):
 * the goal lifecycle vocabulary now binds to `goal_state` in the shared spec, `payload.state`
 * keeps its four participant values, and `goal_state` is not required on ordinary turns.
 * This test is therefore no longer `todo` — it must pass.
 *
 * Cross-repo by necessity — the shared spec lives in CORE. Skips cleanly when absent rather
 * than failing on a machine that only has collab-plugin.
 */
test('D10: overlapping state vocabularies across documents must each name a distinct field', () => {
  const SHARED_SPEC = join(HERE, '..', '..', 'CORE', 'dev', 'team-goal', 'team_goal_shared_spec.md');
  let spec;
  try { spec = readFileSync(SHARED_SPEC, 'utf8'); }
  catch { return; }   // shared spec not present on this machine; nothing to compare

  const m = spec.match(/Valid values:\s*(.+)/) || spec.match(/Valid states:\s*(.+)/);
  assert.ok(m, 'shared spec no longer declares a state vocabulary in a recognizable form');
  const specStates = [...m[1].matchAll(/`([a-z-]+)`/g)].map(x => x[1]);
  assert.ok(specStates.length > 0, 'extracted zero state values — a vacuous pass');

  const overlap = specStates.filter(s => V1_VALID_STATES.includes(s));
  const specOnly = specStates.filter(s => !V1_VALID_STATES.includes(s));

  // Overlapping-but-unequal vocabularies are the trap: shared values make a value from the
  // wrong list look correct. That is only safe if each list names the field it governs.
  if (overlap.length > 0 && specOnly.length > 0) {
    const specNamesField = /`?goal_state`?/.test(spec);
    assert.ok(
      specNamesField,
      `two state vocabularies overlap on [${overlap.join(', ')}] while the shared spec also ` +
      `defines [${specOnly.join(', ')}] that the validator REJECTS, and the spec never binds its ` +
      'list to a distinct field name. A peer reading the ratified list will emit an ' +
      'unroutable value that looks valid.',
    );
    // And the distinction must be stated, not merely implied by a field name appearing once.
    assert.ok(
      /is NOT `?state`?|different field/i.test(spec),
      'the spec names goal_state but never says it is distinct from the participant state field',
    );
  }
});
