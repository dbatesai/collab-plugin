import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

let deriveSlug, nextEventId, authorSlugFromTriplet;
try {
  const m = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  deriveSlug = m.deriveSlug;
  nextEventId = m.nextEventId;
  authorSlugFromTriplet = m.authorSlugFromTriplet;
} catch {
  deriveSlug = nextEventId = authorSlugFromTriplet = () => { throw new Error('not implemented'); };
}

test('deriveSlug: basic message', () => {
  assert.equal(deriveSlug('memory architecture review'), 'memory-architecture-review');
});

test('deriveSlug: strips punctuation', () => {
  assert.equal(deriveSlug('review: v2.3 (final)'), 'review-v23-final');
});

test('deriveSlug: max 50 chars', () => {
  assert.ok(deriveSlug('a'.repeat(60)).length <= 50);
});

test('deriveSlug: truncates at word boundary, not mid-word', () => {
  // "v0.2 spec rework collab plugin transport modes spec against" → slug before truncation is long
  const s = deriveSlug('v02 spec rework collab plugin transport modes spec against the changelist');
  assert.ok(s.length <= 50, `length ${s.length} > 50`);
  assert.ok(!s.endsWith('-'), `trailing dash: ${s}`);
  // Must end at a word boundary (last char before truncation is alphanumeric, not mid-word)
  assert.ok(/[a-z0-9]$/.test(s), `ends mid-word: ${s}`);
  // The prior bug: 'rework-collabplugin-v02-transportmodes-spec-agains' — ends with partial word
  assert.ok(!s.endsWith('agains'), `mid-word cut: ${s}`);
});

test('deriveSlug: word-boundary truncation does not cut short words', () => {
  // Exact 50-char slug with hyphen at position 49: should keep all 50
  const msg = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk ll mm';
  const s = deriveSlug(msg);
  assert.ok(s.length <= 50);
  assert.ok(!s.endsWith('-'));
});

test('deriveSlug: collapses whitespace', () => {
  assert.equal(deriveSlug('hello   world'), 'hello-world');
});

test('deriveSlug: no trailing dash', () => {
  const s = deriveSlug('hello!');
  assert.ok(!s.endsWith('-'), `got: ${s}`);
});

test('nextEventId: first event returns evt-001', () => {
  assert.equal(nextEventId([]), 'evt-001');
});

test('nextEventId: increments from last', () => {
  assert.equal(nextEventId([{ event_id: 'evt-001' }, { event_id: 'evt-002' }]), 'evt-003');
});

test('nextEventId: widens at 999', () => {
  assert.equal(nextEventId([{ event_id: 'evt-999' }]), 'evt-1000');
});

test('authorSlugFromTriplet: extracts workspace id', () => {
  assert.equal(authorSlugFromTriplet('core-framework@claude-code:home'), 'core-framework');
});

let buildKickoffPayload, buildSelfJoinPayload, kickoff;
try {
  ({ buildKickoffPayload, buildSelfJoinPayload, kickoff } = await import('../skills/collab/scripts/collab-kickoff.mjs'));
} catch {
  buildKickoffPayload = buildSelfJoinPayload = kickoff = () => { throw new Error('not implemented'); };
}

test('buildKickoffPayload has all required IGM fields', () => {
  const p = buildKickoffPayload('do a review', { intention:'i', goal:'g', measure:'m' }, [], 24);
  assert.ok(p.igm.intention && p.igm.goal && p.igm.measure);
  assert.equal(p.message, 'do a review');
  assert.equal(p.wall_clock_hours, 24);
  assert.ok(Array.isArray(p.capabilities_wanted));
});
test('buildSelfJoinPayload has required fields', () => {
  const p = buildSelfJoinPayload(['architecture-review'], 'I will review the arch');
  assert.ok(Array.isArray(p.capability_match));
  assert.ok(p.commitment);
});

test('buildKickoffPayload includes transport, ratification_window_minutes, min_collab_plugin_version', () => {
  const payload = buildKickoffPayload('msg', { intention: 'i', goal: 'g', measure: 'm' }, [], 24, 2, undefined, {
    transport: 'localhost',
    ratificationWindowMinutes: 30,
    minCollabPluginVersion: '0.2.0',
  });
  assert.equal(payload.transport, 'localhost');
  assert.equal(payload.tick_interval_minutes, 2);
  assert.equal(payload.ratification_window_minutes, 30);
  assert.equal(payload.min_collab_plugin_version, '0.2.0');
});

// ---------------------------------------------------------------- eligibility v1: writer gate
//
// The plugin guarantees what its writer emits: a kickoff it creates for a non-solo session
// declares valid completion measures. `capabilities_wanted` non-empty is the non-solo signal.
// Each refusal test is paired with the same payload minus the defect, so a gate that refuses
// everything cannot pass.

const IGM = { intention: 'i', goal: 'g', measure: 'three independent accepts' };
const R1 = 'core-codex@codex:host';
const validMeasure = { id: 'M-A', description: 'adapter conforms to the shared spec', requires_review_from: R1 };

test('writer gate: a non-solo kickoff without measures is refused (completion-measures-required)', () => {
  assert.throws(
    () => buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, {}),
    /completion-measures-required/,
  );
  // control: the same kickoff with one valid measure is accepted
  const p = buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, { measures: [validMeasure] });
  assert.deepEqual(p.ratified_completion_measures, [validMeasure]);
});

test('writer gate: a solo kickoff (no capabilities wanted) needs no measures', () => {
  const p = buildKickoffPayload('msg', IGM, [], 24, 5, undefined, {});
  assert.equal(p.ratified_completion_measures, undefined);
});

test('writer gate: a placeholder description is refused by id (completion-measure-placeholder)', () => {
  const placeholder = { ...validMeasure, description: "(measure inferred as 'reasonable consensus on goal'; refine in first turn)" };
  assert.throws(
    () => buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, { measures: [placeholder] }),
    /completion-measure-placeholder: M-A/,
  );
  assert.throws(
    () => buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, { measures: [{ ...validMeasure, description: '' }] }),
    /completion-measure-invalid: M-A/,
  );
});

test('writer gate: duplicate ids and missing reviewer are refused by id (completion-measure-invalid)', () => {
  assert.throws(
    () => buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, { measures: [validMeasure, { ...validMeasure, description: 'second' }] }),
    /completion-measure-invalid: M-A/,
  );
  assert.throws(
    () => buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, { measures: [{ id: 'M-B', description: 'x' }] }),
    /completion-measure-invalid: M-B/,
  );
});

test('writer gate: --required-review still generates a full measure and merges with --measure', () => {
  const p = buildKickoffPayload('msg', IGM, ['review'], 24, 5, undefined, {
    requiredReviews: ['core-gemini@antigravity:host'],
    measures: [validMeasure],
  });
  const ids = p.ratified_completion_measures.map(m => m.id);
  assert.deepEqual(ids, ['independent-review-core-gemini', 'M-A']);
  for (const m of p.ratified_completion_measures) {
    assert.ok(m.description && m.requires_review_from, `generated measure incomplete: ${JSON.stringify(m)}`);
  }
});

let parseMeasureFlag;
try { ({ parseMeasureFlag } = await import('../skills/collab/scripts/collab-kickoff.mjs')); }
catch { parseMeasureFlag = undefined; }

test('writer gate: --measure "<id>|<description>|<triplet>" parses, and malformed values are refused', () => {
  assert.equal(typeof parseMeasureFlag, 'function', 'parseMeasureFlag is not exported');
  assert.deepEqual(
    parseMeasureFlag('M-A|adapter conforms|core-codex@codex:host'),
    { id: 'M-A', description: 'adapter conforms', requires_review_from: 'core-codex@codex:host' },
  );
  assert.throws(() => parseMeasureFlag('M-A|only two parts'), /--measure/);
  assert.throws(() => parseMeasureFlag('|desc|core-codex@codex:host'), /--measure/);
});

test('kickoff rejects when slug already exists in any transport', async () => {
  const { LOCAL_COLLABS_ROOT } = await import('../skills/collab/scripts/transport.mjs');
  const { appendEvent } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  const stamp = Date.now();
  const slug = `kickoff-collision-test-${stamp}`;
  const dirName = `2026-05-25-${slug}`;
  const collisionDir = join(LOCAL_COLLABS_ROOT, dirName);
  mkdirSync(join(collisionDir, 'events'), { recursive: true });
  appendEvent(collisionDir, {
    event_id: 'evt-001',
    ts: '2026-05-25T09:22:00Z',
    author: 'a@cc:m5',
    slug,
    type: 'kickoff',
    references: [],
    payload: {},
  });
  try {
    // Phrase kickoff message so deriveSlug produces the same slug
    // (deriveSlug replaces non-alnum with hyphens; spaces → hyphens; collapse).
    const message = slug.replace(/-/g, ' ');
    await assert.rejects(
      () => kickoff(message, { transport: 'github:files', dryRun: false, workspaceId: 'test' }),
      /already exists/,
    );
  } finally {
    rmSync(collisionDir, { recursive: true, force: true });
  }
});

test('kickoff --dry-run refuses a slug that already exists instead of appending into the live collab', async () => {
  const { spawnSync } = await import('node:child_process');
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'collab-dryrun-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, COLLAB_LOCAL_ROOT: join(home, 'local'), COLLAB_REPOS_ROOT: join(home, 'repos') };
  const cli = new URL('../skills/collab/scripts/collab-kickoff.mjs', import.meta.url).pathname;
  const run = (...extra) => spawnSync(process.execPath, [cli, 'review the widget plan', '--workspace-id', 'w1', '--transport', 'localhost', ...extra], { env, encoding: 'utf8' });
  try {
    assert.equal(run().status, 0);
    const [dir] = readdirSync(join(home, 'local'));
    const eventsPath = join(home, 'local', dir, 'events.jsonl');
    const before = readFileSync(eventsPath, 'utf8');
    const dry = run('--dry-run');
    assert.notEqual(dry.status, 0, 'dry run on an existing slug must refuse');
    assert.match(dry.stderr, /already exists/);
    assert.equal(readFileSync(eventsPath, 'utf8'), before, 'live event log must be untouched');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
