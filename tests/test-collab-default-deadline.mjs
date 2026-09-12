/**
 * test-collab-default-deadline.mjs — eligibility v1, deadlines by default.
 *
 * A turn without `next_update_by` gets its own timestamp plus the kickoff cadence, computed
 * at read time and never written back; `on_timeout` defaults to `proceed-alone`, the only
 * action that moves no ownership. Only the participant's own event resets their deadline;
 * chase turns reset nothing; the outer bounds are untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let H;
try { H = await import('../skills/collab/scripts/collab-event-helpers.mjs'); }
catch { H = {}; }
const { effectiveDeadline, effectiveOnTimeout, evaluateObligations, checkSafetyNets } = H;

const P = 'core-framework@claude-code:host';
const R1 = 'core-codex@codex:host';
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 11, 10, 0);
const iso = (ms) => new Date(ms).toISOString();

function ledger() {
  const events = [];
  let n = 0;
  const add = (author, type, min, payload, references = []) => {
    const e = { event_id: `evt-${String(++n).padStart(3, '0')}`, ts: iso(T0 + min * MIN), author, slug: 'dl', type, references, payload };
    events.push(e);
    return e;
  };
  const ko = add(P, 'kickoff', 0, { message: 'm', igm: { intention: 'i', goal: 'g', measure: 'x' }, capabilities_wanted: [], wall_clock_hours: 24, transport: 'localhost', tick_interval_minutes: 5 });
  add(P, 'join', 0, { capability_match: [], commitment: 'c' }, [ko.event_id]);
  add(R1, 'join', 1, { capability_match: [], commitment: 'c' }, [ko.event_id]);
  return { events, add };
}

const turnPayload = (extra = {}) => ({ intent: 'propose', body: 'b', signals: [], state: 'working', owner: R1, waiting_on: null, ...extra });

test('effectiveDeadline: a strict ISO next_update_by is used as-is', () => {
  const { events, add } = ledger();
  const t = add(R1, 'turn', 10, turnPayload({ next_update_by: iso(T0 + 45 * MIN) }));
  assert.equal(effectiveDeadline(t, events), iso(T0 + 45 * MIN));
});

test('effectiveDeadline: missing, empty, or non-ISO next_update_by → turn timestamp plus one cadence', () => {
  const { events, add } = ledger();
  for (const v of [undefined, '', '1:00 AM EDT']) {
    const t = add(R1, 'turn', 10, turnPayload(v === undefined ? {} : { next_update_by: v }));
    assert.equal(effectiveDeadline(t, events), iso(T0 + 15 * MIN), `value ${JSON.stringify(v)}`);
  }
});

test('effectiveOnTimeout: declared action wins; absent → proceed-alone; unrecognized → null (an error, not an absence)', () => {
  assert.equal(effectiveOnTimeout({ payload: { on_timeout: 'reassign' } }), 'reassign');
  assert.equal(effectiveOnTimeout({ payload: {} }), 'proceed-alone');
  assert.equal(effectiveOnTimeout({ payload: { on_timeout: '' } }), 'proceed-alone');
  assert.equal(effectiveOnTimeout({ payload: { on_timeout: 'panic' } }), null);
});

test('obligations: a turn with no deadline becomes due one cadence plus grace later, with proceed-alone', () => {
  const { events, add } = ledger();
  add(R1, 'turn', 10, turnPayload());
  // cadence 5 min → deadline T0+15; grace 5 min → due at T0+20
  const before = evaluateObligations(events, { now: T0 + 19 * MIN, self: P });
  assert.ok(!before.due.some(d => d.participant === R1), 'due before the grace elapsed');
  const after = evaluateObligations(events, { now: T0 + 21 * MIN, self: P });
  const forR1 = after.due.find(d => d.participant === R1);
  assert.ok(forR1, 'no obligation came due for a turn that declared nothing');
  assert.equal(forR1.action, 'chase', 'the first response to a missed deadline is a chase');
  assert.equal(forR1.for_deadline, iso(T0 + 15 * MIN));
  assert.deepEqual(after.invalid, [], 'a defaulted turn must not be reported as an unbounded wait');
  // After the chase sequence is exhausted the DEFAULT action executes, not a declared one.
  for (let i = 0; i < H.CHASE_FLOOD_LIMIT; i++) {
    add(P, 'turn', 21 + i, { intent: 'clarify', body: 'Obligation missed', signals: ['chase', 'obligation-missed', R1], state: 'blocked', owner: R1, waiting_on: R1 });
  }
  const exhausted = evaluateObligations(events, { now: T0 + 30 * MIN, self: P });
  assert.equal(exhausted.due.find(d => d.participant === R1)?.action, 'proceed-alone');
});

test('obligations: a chase turn from another participant does not reset the deadline; the participant\'s own turn does', () => {
  const { events, add } = ledger();
  add(R1, 'turn', 10, turnPayload());                                            // due at T0+20
  add(P, 'turn', 21, { intent: 'clarify', body: 'Obligation missed', signals: ['chase', 'obligation-missed', R1], state: 'blocked', owner: R1, waiting_on: R1, next_update_by: '' });
  assert.ok(evaluateObligations(events, { now: T0 + 22 * MIN, self: P }).due.some(d => d.participant === R1), 'the chase reset the deadline');
  add(R1, 'turn', 23, turnPayload());                                            // own event: new deadline T0+28, due T0+33
  assert.ok(!evaluateObligations(events, { now: T0 + 30 * MIN, self: P }).due.some(d => d.participant === R1), 'own turn did not reset the deadline');
  assert.ok(evaluateObligations(events, { now: T0 + 34 * MIN, self: P }).due.some(d => d.participant === R1));
});

test('obligations: a chase turn never creates an obligation for the chaser', () => {
  const { events, add } = ledger();
  add(P, 'turn', 10, { intent: 'clarify', body: 'Obligation missed', signals: ['chase', 'obligation-missed', R1], state: 'blocked', owner: R1, waiting_on: R1, next_update_by: '' });
  const obl = evaluateObligations(events, { now: T0 + 60 * MIN, self: R1 });
  assert.ok(!obl.due.some(d => d.participant === P), 'a system chase turn was treated as a commitment by its author');
});

test('outer bounds: defaults change nothing about the wall-clock or stall nets', () => {
  const { events, add } = ledger();
  add(R1, 'turn', 10, turnPayload());
  assert.equal(checkSafetyNets(events, iso(T0 + 20 * MIN)), null);
  assert.equal(checkSafetyNets(events, iso(T0 + 10 * MIN + 31 * MIN)), 'stall');      // 6 × 5 min after the last event
  assert.equal(checkSafetyNets(events, iso(T0 + 25 * 60 * MIN)), 'wall-clock');
});
