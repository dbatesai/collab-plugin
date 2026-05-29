import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SILENCE_RATIFY_MS, TICK_INTERVAL_MS, getRatificationWindowMs } from '../skills/collab/scripts/collab-event-helpers.mjs';

let checkSafetyNets, getRatificationStatus, hasJoined;
let detectRoute;
try {
  ({ checkSafetyNets, getRatificationStatus, hasJoined } =
    await import('../skills/collab/scripts/collab-event-helpers.mjs'));
  ({ detectRoute } = await import('../skills/collab/scripts/collab-tick.mjs'));
} catch {
  checkSafetyNets = getRatificationStatus = hasJoined = detectRoute = () => { throw new Error('not implemented'); };
}

const T0 = '2026-05-25T10:00:00Z';
const T25H = '2026-05-26T11:00:00Z';
const T3H5M = '2026-05-25T13:05:00Z';
const KO = { event_id:'evt-001', ts:T0, author:'core@cc:home', slug:'s', type:'kickoff', references:[],
  payload:{ message:'t', igm:{intention:'i',goal:'g',measure:'m'}, capabilities_wanted:[], wall_clock_hours:24 } };
const JN = { event_id:'evt-002', ts:T0, author:'bblens@cc:work', slug:'s', type:'join', references:[],
  payload:{ capability_match:[], commitment:'ok' } };

test('no safety net on fresh collab', () => {
  assert.equal(checkSafetyNets([KO, JN], '2026-05-25T11:00:00Z'), null);
});
test('wall-clock triggers after 24h', () => {
  assert.equal(checkSafetyNets([KO, JN], T25H), 'wall-clock');
});
test('stall triggers after 6 ticks of silence', () => {
  assert.equal(checkSafetyNets([KO, JN], T3H5M), 'stall');
});
test('stall does not trigger with recent event', () => {
  const recent = { ...JN, event_id:'evt-003', ts:'2026-05-25T11:55:00Z', type:'turn',
    payload:{ intent:'propose', body:'hi', signals:[] } };
  assert.equal(checkSafetyNets([KO, JN, recent], '2026-05-25T12:00:00Z'), null);
});
test('objection-deadlock triggers after 3 cycles', () => {
  const events = [KO, JN];
  for (let i=0; i<3; i++) {
    events.push({ event_id:`evt-${events.length+1}`, ts:T0, author:'core@cc:home', slug:'s',
      type:'propose-close', references:[], payload:{ synthesis:'x', igm_met:{} } });
    events.push({ event_id:`evt-${events.length+1}`, ts:T0, author:'bblens@cc:work', slug:'s',
      type:'object', references:[], payload:{ reason:'nope' } });
  }
  assert.equal(checkSafetyNets(events, T0), 'objection-deadlock');
});
test('ratification converged when all ratify', () => {
  const events = [KO, JN,
    { event_id:'evt-003', ts:T0, author:'core@cc:home', slug:'s', type:'propose-close', references:[],
      payload:{ synthesis:'x', igm_met:{} } },
    { event_id:'evt-004', ts:T0, author:'bblens@cc:work', slug:'s', type:'ratify', references:['evt-003'], payload:{} }];
  const s = getRatificationStatus(events);
  assert.ok(s.converged);
});
test('ratification not converged with pending agents', () => {
  const events = [KO, JN,
    { event_id:'evt-003', ts:T0, author:'core@cc:home', slug:'s', type:'propose-close', references:[],
      payload:{ synthesis:'x', igm_met:{} } }];
  // Pin nowTs to the propose-close instant — otherwise the default real-now makes
  // this time-dependent: by any date past the silence-ratification window the
  // pending agent is implicitly ratified and `converged` flips to true.
  // (Found session 52: this was the lone suite flake. HC diagnosed; fix = pin nowTs.)
  const s = getRatificationStatus(events, T0);
  assert.equal(s.converged, false);
  assert.ok(s.pending.includes('bblens@cc:work'));
});
test('hasJoined true for joined agent', () => { assert.equal(hasJoined([KO, JN], 'bblens@cc:work'), true); });
test('hasJoined false for unknown agent', () => { assert.equal(hasJoined([KO, JN], 'other@cc:home'), false); });
test('detectRoute returns closed on closed collab', () => {
  const cl = { event_id:'evt-003', ts:T0, author:'core@cc:home', slug:'s', type:'close', references:[],
    payload:{ final_synthesis:'done', outcome:'converged' } };
  assert.equal(detectRoute([KO, JN, cl], 'any', T0), 'closed');
});

test('single-agent: propose-close is immediately converged (no others to ratify)', () => {
  const events = [
    { event_id:'evt-001', ts:T0, author:'solo@cc:home', slug:'s', type:'kickoff', references:[],
      payload:{ message:'t', igm:{intention:'i',goal:'g',measure:'m'}, capabilities_wanted:[], wall_clock_hours:24 } },
    { event_id:'evt-002', ts:T0, author:'solo@cc:home', slug:'s', type:'join', references:[],
      payload:{ capability_match:[], commitment:'solo' } },
    { event_id:'evt-003', ts:T0, author:'solo@cc:home', slug:'s', type:'propose-close', references:[],
      payload:{ synthesis:'done', igm_met:{} } },
  ];
  const status = getRatificationStatus(events);
  assert.ok(status, 'expected ratification status object');
  assert.equal(status.converged, true, 'single-agent should converge immediately');
  assert.equal(status.otherAgents.length, 0, 'no other agents');
});

// --- silence-as-ratification (finding #7) ---

const PROPOSE_TS = '2026-05-25T10:00:00Z';
const SILENT_AGENT = 'silent@cc:m2';
const ACTIVE_AGENT = 'active@cc:m3';

function buildProposeCloseEvents() {
  return [
    { event_id:'evt-001', ts:'2026-05-25T09:00:00Z', author:'orig@cc:m1', slug:'s', type:'kickoff', references:[],
      payload:{ message:'t', igm:{intention:'i',goal:'g',measure:'m'}, capabilities_wanted:[], wall_clock_hours:24 } },
    { event_id:'evt-002', ts:'2026-05-25T09:00:00Z', author:'orig@cc:m1', slug:'s', type:'join', references:[],
      payload:{ capability_match:[], commitment:'orig' } },
    { event_id:'evt-003', ts:'2026-05-25T09:05:00Z', author:SILENT_AGENT, slug:'s', type:'join', references:[],
      payload:{ capability_match:[], commitment:'will go offline' } },
    { event_id:'evt-004', ts:'2026-05-25T09:05:00Z', author:ACTIVE_AGENT, slug:'s', type:'join', references:[],
      payload:{ capability_match:[], commitment:'will respond' } },
    { event_id:'evt-005', ts:PROPOSE_TS, author:'orig@cc:m1', slug:'s', type:'propose-close', references:[],
      payload:{ synthesis:'done', igm_met:{} } },
  ];
}

test('silence-as-ratification: not yet eligible (within window)', () => {
  const events = buildProposeCloseEvents();
  // 30 min after propose-close — under SILENCE_RATIFY_MS (90min)
  const r = getRatificationStatus(events, '2026-05-25T10:30:00Z');
  assert.equal(r.converged, false);
  assert.deepEqual(r.implicitRatified, [], 'no implicit ratification before window elapses');
  assert.deepEqual(r.pending.sort(), [SILENT_AGENT, ACTIVE_AGENT].sort());
});

test('silence-as-ratification: eligible, silent agents auto-ratified', () => {
  const events = buildProposeCloseEvents();
  // 91 min after propose-close — past SILENCE_RATIFY_MS
  const r = getRatificationStatus(events, '2026-05-25T11:31:00Z');
  assert.equal(r.converged, true, 'should converge when all pending agents have been silent past window');
  assert.deepEqual(r.implicitRatified.sort(), [SILENT_AGENT, ACTIVE_AGENT].sort());
  assert.deepEqual(r.pending, []);
});

test('silence-as-ratification: agent emitted a turn since propose-close → still pending', () => {
  const events = buildProposeCloseEvents();
  events.push({ event_id:'evt-006', ts:'2026-05-25T10:30:00Z', author:ACTIVE_AGENT, slug:'s', type:'turn',
    references:['evt-005'], payload:{ intent:'critique', body:'wait', signals:[] } });
  // 91 min after propose-close
  const r = getRatificationStatus(events, '2026-05-25T11:31:00Z');
  // ACTIVE_AGENT emitted an event since propose-close → still pending (NOT silent)
  // SILENT_AGENT emitted nothing → implicitly ratified
  assert.deepEqual(r.implicitRatified, [SILENT_AGENT]);
  assert.ok(r.pending.includes(ACTIVE_AGENT), 'agent with activity is still pending');
  assert.equal(r.converged, false);
});

test('silence-as-ratification: explicit ratify still works alongside implicit', () => {
  const events = buildProposeCloseEvents();
  events.push({ event_id:'evt-006', ts:'2026-05-25T10:05:00Z', author:ACTIVE_AGENT, slug:'s', type:'ratify',
    references:['evt-005'], payload:{ agreement_notes:'agreed' } });
  // 91 min after propose-close
  const r = getRatificationStatus(events, '2026-05-25T11:31:00Z');
  assert.deepEqual(r.explicitRatified, [ACTIVE_AGENT]);
  assert.deepEqual(r.implicitRatified, [SILENT_AGENT]);
  assert.deepEqual(r.ratified.sort(), [ACTIVE_AGENT, SILENT_AGENT].sort());
  assert.equal(r.converged, true);
});

test('silence-as-ratification: explicit object blocks convergence even with silence elapsed', () => {
  const events = buildProposeCloseEvents();
  events.push({ event_id:'evt-006', ts:'2026-05-25T10:05:00Z', author:ACTIVE_AGENT, slug:'s', type:'object',
    references:['evt-005'], payload:{ reason:'not done' } });
  const r = getRatificationStatus(events, '2026-05-25T11:31:00Z');
  assert.deepEqual(r.objected, [ACTIVE_AGENT]);
  assert.equal(r.converged, false, 'objection blocks even with silence elapsed');
});

test('SILENCE_RATIFY_MS constant exported and equals 3*TICK_INTERVAL_MS', () => {
  assert.equal(SILENCE_RATIFY_MS, 3 * TICK_INTERVAL_MS);
});

// --- getRatificationWindowMs (v0.2 §4.4) ---

test('getRatificationWindowMs reads ratification_window_minutes from kickoff payload', () => {
  const kickoff = { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'kickoff', references: [], payload: { transport: 'localhost', tick_interval_minutes: 2, ratification_window_minutes: 45 } };
  assert.equal(getRatificationWindowMs([kickoff]), 45 * 60 * 1000);
});

test('getRatificationWindowMs falls back to 3 × tick_interval when ratification_window_minutes absent (v0.1.x compat)', () => {
  const kickoff = { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'kickoff', references: [], payload: { tick_interval_minutes: 10 } };
  assert.equal(getRatificationWindowMs([kickoff]), 30 * 60 * 1000);
});

test('getRatificationWindowMs uses default 30min when no tick_interval and no ratification_window_minutes', () => {
  const kickoff = { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'kickoff', references: [], payload: {} };
  // 3 × 30min default = 90min
  assert.equal(getRatificationWindowMs([kickoff]), 90 * 60 * 1000);
});
