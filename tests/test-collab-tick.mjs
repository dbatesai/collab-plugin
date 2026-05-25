import { test } from 'node:test';
import assert from 'node:assert/strict';

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
  const s = getRatificationStatus(events);
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
