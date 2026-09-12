/**
 * test-collab-wait-cycle.mjs — eligibility v1, requests you can see.
 *
 * Every v1 turn already names `waiting_on`; nobody read it from the recipient's side.
 * A request is open from the requesting turn until an explicit disposition tied to it:
 * the recipient's `declined` or `delivered` (or a scoped verdict referencing it), or the
 * requester's own timeout fallback (`lapsed`). `accepted` changes its state, not its
 * visibility; any other referencing turn changes nothing (Hale's correction).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let H;
try { H = await import('../skills/collab/scripts/collab-event-helpers.mjs'); }
catch { H = {}; }
const { openRequests, waitCycles } = H;

const A = 'core-framework@claude-code:host';
const B = 'core-codex@codex:host';
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 11, 10, 0);
const iso = (ms) => new Date(ms).toISOString();

function ledger() {
  const events = [];
  let n = 0;
  const add = (author, type, min, payload, references = []) => {
    const e = { event_id: `evt-${String(++n).padStart(3, '0')}`, ts: iso(T0 + min * MIN), author, slug: 'wc', type, references, payload };
    events.push(e);
    return e;
  };
  const ko = add(A, 'kickoff', 0, {
    message: 'm', igm: { intention: 'i', goal: 'g', measure: 'x' }, capabilities_wanted: ['review'], wall_clock_hours: 24,
    transport: 'localhost', tick_interval_minutes: 5,
    ratified_completion_measures: [{ id: 'M-B', description: 'B reviews', requires_review_from: B }],
  });
  add(A, 'join', 0, { capability_match: [], commitment: 'c' }, [ko.event_id]);
  add(B, 'join', 1, { capability_match: [], commitment: 'c', owes_review: ['M-B'] }, [ko.event_id]);
  return { events, add };
}

const turn = (extra) => ({ intent: 'probe', body: 'b', signals: [], state: 'blocked', owner: B, waiting_on: B, ...extra });
const request = (add) => add(A, 'turn', 10, turn({ body: 'please review M-B', next_update_by: iso(T0 + 40 * MIN), on_timeout: 'proceed-alone' }));

test('request: a turn naming waiting_on shows up for the recipient as requested', () => {
  const { events, add } = ledger();
  const req = request(add);
  const open = openRequests(events, B);
  assert.equal(open.length, 1);
  assert.equal(open[0].request_id, req.event_id);
  assert.equal(open[0].from, A);
  assert.equal(open[0].state, 'requested');
  assert.equal(open[0].deadline, iso(T0 + 40 * MIN));
  assert.equal(open[0].on_timeout, 'proceed-alone');
  assert.deepEqual(openRequests(events, A), [], 'the requester has no open request on themselves');
});

test('request: a clarifying question that references it leaves it requested and visible', () => {
  const { events, add } = ledger();
  const req = request(add);
  add(B, 'turn', 12, turn({ intent: 'clarify', body: 'which branch?', owner: A, waiting_on: A }), [req.event_id]);
  const open = openRequests(events, B);
  assert.equal(open.length, 1);
  assert.equal(open[0].state, 'requested');
});

test('request: accepted changes the state, not the visibility; a later progress note changes nothing', () => {
  const { events, add } = ledger();
  const req = request(add);
  add(B, 'turn', 12, turn({ signals: ['accepted'], next_update_by: iso(T0 + 30 * MIN) }), [req.event_id]);
  assert.equal(openRequests(events, B)[0].state, 'accepted');
  add(B, 'turn', 14, turn({ intent: 'clarify', body: 'halfway there' }), [req.event_id]);
  assert.equal(openRequests(events, B).length, 1);
  assert.equal(openRequests(events, B)[0].state, 'accepted');
});

test('request: declined closes it; delivered closes it; a scoped verdict referencing it closes it', () => {
  for (const disposition of ['declined', 'delivered', 'verdict']) {
    const { events, add } = ledger();
    const req = request(add);
    if (disposition === 'verdict') add(B, 'ratify', 15, { measures: ['M-B'] }, [req.event_id]);
    else add(B, 'turn', 15, turn({ signals: [disposition], body: disposition }), [req.event_id]);
    assert.deepEqual(openRequests(events, B), [], `${disposition} did not close the request`);
  }
});

test('request: the requester\'s own timeout fallback lapses it — and the measure stays unmet', () => {
  const { events, add } = ledger();
  const req = request(add);
  add(A, 'timeout-action', 46, { schema_version: '1.0', action: 'proceed-alone', participant: A, for_deadline: iso(T0 + 40 * MIN), chases_so_far: 3, signals: ['timeout-executed', 'proceed-alone'] });
  assert.deepEqual(openRequests(events, B), []);
  const all = openRequests(events, B, { includeClosed: true });
  assert.equal(all[0].request_id, req.event_id);
  assert.equal(all[0].state, 'lapsed');
  assert.deepEqual(H.unmetRequiredReviews(events, iso(T0 + 50 * MIN)).map(m => m.id), ['M-B']);
});

test('cycle: A→B and B→A open requests form one pair with a stable key; acceptance does not dissolve it', () => {
  const { events, add } = ledger();
  const rA = request(add);
  const rB = add(B, 'turn', 11, turn({ owner: A, waiting_on: A, body: 'I need your fixture first', next_update_by: iso(T0 + 41 * MIN), on_timeout: 'proceed-alone' }));
  const pairs = waitCycles(events);
  assert.equal(pairs.length, 1);
  assert.deepEqual([pairs[0].requests[0], pairs[0].requests[1]].sort(), [rA.event_id, rB.event_id].sort());
  assert.equal(pairs[0].key, [rA.event_id, rB.event_id].sort().join('+'));
  add(B, 'turn', 12, turn({ signals: ['accepted'] }), [rA.event_id]);
  add(A, 'turn', 13, turn({ signals: ['accepted'], owner: A, waiting_on: A }), [rB.event_id]);
  assert.equal(waitCycles(events).length, 1, 'both accepted and still mutually waiting is still a cycle');
  add(B, 'turn', 14, turn({ signals: ['delivered'] }), [rA.event_id]);
  assert.equal(waitCycles(events).length, 0, 'a delivered request dissolves the pair');
});
