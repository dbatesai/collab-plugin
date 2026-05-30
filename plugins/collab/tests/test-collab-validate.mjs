import { test } from 'node:test';
import assert from 'node:assert/strict';

let validateEvents;
try { ({ validateEvents } = await import('../skills/collab/scripts/collab-validate.mjs')); }
catch { validateEvents = () => { throw new Error('not implemented'); }; }

const KO = {
  event_id: 'evt-001', ts: '2026-05-25T10:00:00Z',
  author: 'core-framework@claude-code:home', slug: 'test', type: 'kickoff', references: [],
  payload: { message: 'test', igm: { intention: 'i', goal: 'g', measure: 'm' }, capabilities_wanted: [], wall_clock_hours: 24 },
};
const JN = {
  event_id: 'evt-002', ts: '2026-05-25T10:30:00Z',
  author: 'bblens@claude-code:work', slug: 'test', type: 'join', references: ['evt-001'],
  payload: { capability_match: ['bblens-context'], commitment: 'ok' },
};

test('valid kickoff passes', () => { assert.equal(validateEvents([KO]).valid, true); });
test('valid join passes', () => { assert.equal(validateEvents([KO, JN]).valid, true); });
test('missing author field fails', () => {
  const r = validateEvents([{ ...KO, author: undefined }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('author')));
});
test('unknown event type fails', () => {
  const r = validateEvents([{ ...KO, type: 'mystery' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('mystery')));
});
test('duplicate event_id fails', () => {
  const r = validateEvents([KO, { ...JN, event_id: 'evt-001' }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('duplicate')));
});
test('missing kickoff igm fails', () => {
  const r = validateEvents([{ ...KO, payload: { ...KO.payload, igm: undefined } }]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('igm')));
});
test('turn with invalid intent fails', () => {
  const turn = { event_id: 'evt-003', ts: '2026-05-25T11:00:00Z', author: 'core-framework@claude-code:home',
    slug: 'test', type: 'turn', references: [], payload: { intent: 'rant', body: 'x', signals: [] } };
  const r = validateEvents([KO, JN, turn]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('rant')));
});
test('clock skew >1h produces warning', () => {
  const late = { ...JN, ts: '2026-05-25T12:00:01Z' };
  const r = validateEvents([KO, late]);
  assert.ok(r.warnings.some(w => w.includes('clock skew')));
});
test('valid close passes', () => {
  const cl = { event_id: 'evt-003', ts: '2026-05-25T11:00:00Z', author: 'core-framework@claude-code:home',
    slug: 'test', type: 'close', references: [], payload: { final_synthesis: 'done', outcome: 'converged' } };
  assert.equal(validateEvents([KO, JN, cl]).valid, true);
});
test('close with unknown outcome fails', () => {
  const cl = { event_id: 'evt-003', ts: '2026-05-25T11:00:00Z', author: 'core-framework@claude-code:home',
    slug: 'test', type: 'close', references: [], payload: { final_synthesis: 'x', outcome: 'quit' } };
  const r = validateEvents([KO, JN, cl]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('quit')));
});

test('kickoff with transport=localhost passes', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost' } };
  assert.equal(validateEvents([evt]).valid, true);
});

test('kickoff with transport=github:files passes', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'github:files' } };
  assert.equal(validateEvents([evt]).valid, true);
});

test('kickoff with invalid transport fails', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'mcp:foo' } };
  const r = validateEvents([evt]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('transport')), `expected transport error, got: ${JSON.stringify(r.errors)}`);
});

test('kickoff with transport=github:UPPER fails (lowercase only)', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'github:UPPER' } };
  assert.equal(validateEvents([evt]).valid, false);
});

test('kickoff missing transport emits warning (v0.1.x compat)', () => {
  // KO has no transport field
  const r = validateEvents([KO]);
  assert.equal(r.valid, true); // not an error
  assert.ok(r.warnings.some(w => w.toLowerCase().includes('transport')), `expected transport warning, got: ${JSON.stringify(r.warnings)}`);
});

test('kickoff with ratification_window_minutes in range passes', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost', ratification_window_minutes: 30 } };
  assert.equal(validateEvents([evt]).valid, true);
});

test('kickoff with ratification_window_minutes out of range fails', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost', ratification_window_minutes: 0 } };
  const r = validateEvents([evt]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('ratification_window_minutes')));
});

test('kickoff with ratification_window_minutes too large fails', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost', ratification_window_minutes: 99999 } };
  assert.equal(validateEvents([evt]).valid, false);
});

test('kickoff with min_collab_plugin_version semver passes', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost', min_collab_plugin_version: '0.2.0' } };
  assert.equal(validateEvents([evt]).valid, true);
});

test('kickoff with malformed min_collab_plugin_version fails', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost', min_collab_plugin_version: '0.2' } };
  const r = validateEvents([evt]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('min_collab_plugin_version')));
});

test('kickoff with non-string min_collab_plugin_version fails', () => {
  const evt = { ...KO, payload: { ...KO.payload, transport: 'localhost', min_collab_plugin_version: 0.2 } };
  assert.equal(validateEvents([evt]).valid, false);
});
