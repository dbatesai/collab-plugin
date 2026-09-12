/**
 * test-collab-eligibility.mjs — eligibility v1, read-time semantics (the acceptance set).
 *
 * Setup: kickoff declares M-A, M-B (reviewer R1) and M-C (reviewer R2); proposer P; a
 * participant Q who owes nothing. Five-minute cadence, synthetic timestamps. Every case
 * here is one the reviewers named; the numbering follows the plan's §3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let H;
try { H = await import('../skills/collab/scripts/collab-event-helpers.mjs'); }
catch { H = {}; }
const { measureVerdicts, unmetRequiredReviews, computeCloseOutcome, declaredMeasures } = H;

const P = 'core-framework@claude-code:host';
const R1 = 'core-codex@codex:host';
const R2 = 'core-gemini@antigravity:host';
const Q = 'bblens@claude-code:work';
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 8, 11, 10, 0);
const iso = (ms) => new Date(ms).toISOString();

const MEASURES = [
  { id: 'M-A', description: 'adapter A conforms', requires_review_from: R1 },
  { id: 'M-B', description: 'adapter B conforms', requires_review_from: R1 },
  { id: 'M-C', description: 'Windows run is clean', requires_review_from: R2 },
];

/** A ledger builder: `add(author, type, minutesAfterT0, payload, references)`. */
function ledger({ measures = MEASURES, joinR2 = true } = {}) {
  const events = [];
  let n = 0;
  const add = (author, type, min, payload, references = []) => {
    const e = { event_id: `evt-${String(++n).padStart(3, '0')}`, ts: iso(T0 + min * MIN), author, slug: 'elig', type, references, payload };
    events.push(e);
    return e;
  };
  const kickoffPayload = {
    message: 'm', igm: { intention: 'i', goal: 'g', measure: 'three adapters conform' },
    capabilities_wanted: ['review'], wall_clock_hours: 24, transport: 'localhost', tick_interval_minutes: 5,
  };
  if (measures) kickoffPayload.ratified_completion_measures = measures;
  const ko = add(P, 'kickoff', 0, kickoffPayload);
  add(P, 'join', 0, { capability_match: [], commitment: 'own' }, [ko.event_id]);
  add(R1, 'join', 1, { capability_match: [], commitment: 'review', owes_review: ['M-A', 'M-B'] }, [ko.event_id]);
  if (joinR2) add(R2, 'join', 2, { capability_match: [], commitment: 'review', owes_review: ['M-C'] }, [ko.event_id]);
  add(Q, 'join', 3, { capability_match: [], commitment: 'observe' }, [ko.event_id]);
  return { events, add, ko };
}

const ids = (list) => list.map(x => x.id).sort();

// ---------------------------------------------------------------- shape: scoped vs legacy

test('reader: a scoped verdict credits exactly its ids, labeled scoped', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, { measures: ['M-A'] });
  const v = measureVerdicts(events, iso(T0 + 20 * MIN));
  assert.deepEqual(v.get('M-A').ratified.map(r => ({ by: r.by, scope: r.scope })), [{ by: R1, scope: 'scoped' }]);
  assert.deepEqual(v.get('M-B').ratified, []);
  assert.ok(v.get('M-A').ratified[0].event_id, 'credit must link to its ledger event');
});

test('reader: a scoped verdict counts with no propose-close at all (declaration → close window)', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, { measures: ['M-A'] });
  const unmet = unmetRequiredReviews(events, iso(T0 + 20 * MIN));
  assert.deepEqual(ids(unmet), ['M-B', 'M-C']);
});

test('reader: a bare verdict from a named reviewer is legacy-shaped — author-wide credit, labeled legacy, scoped to the active propose-close as today', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, {});                                  // before any propose-close: not counted (legacy scoping)
  assert.deepEqual(ids(unmetRequiredReviews(events, iso(T0 + 15 * MIN))), ['M-A', 'M-B', 'M-C']);
  const pc = add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  add(R1, 'ratify', 22, {}, [pc.event_id]);                   // after it: discharges every measure naming R1
  const v = measureVerdicts(events, iso(T0 + 30 * MIN));
  assert.equal(v.get('M-A').ratified[0].scope, 'legacy');
  assert.equal(v.get('M-B').ratified[0].scope, 'legacy');
  assert.deepEqual(ids(unmetRequiredReviews(events, iso(T0 + 30 * MIN))), ['M-C']);
});

test('reader: a duplicate scoped verdict is ignored — the first judgment stands', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, { measures: ['M-A'] });
  add(R1, 'object', 12, { reason: 'changed mind', measures: ['M-A'] });
  const v = measureVerdicts(events, iso(T0 + 20 * MIN));
  assert.equal(v.get('M-A').ratified.length, 1);
  assert.equal(v.get('M-A').objected.length, 0);
});

test('reader: a verdict after the close event is correspondence and never counts', () => {
  const { events, add } = ledger();
  add(P, 'close', 30, { final_synthesis: 'x', outcome: 'failed-safely' });
  add(R1, 'ratify', 31, { measures: ['M-A'] });
  const v = measureVerdicts(events, iso(T0 + 40 * MIN));
  assert.deepEqual(v.get('M-A').ratified, []);
  assert.deepEqual(ids(unmetRequiredReviews(events, iso(T0 + 40 * MIN))), ['M-A', 'M-B', 'M-C']);
});

// ---------------------------------------------------------------- the acceptance cases

test('case 1 — never joins: R2 stays missing at close, the contract is unchanged', () => {
  const { events, add } = ledger({ joinR2: false });
  const pc = add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  add(R1, 'ratify', 21, { measures: ['M-A', 'M-B'] }, [pc.event_id]);
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'proposer' });
  assert.equal(r.outcome, 'complete-to-authority-boundary');
  assert.deepEqual(ids(r.receipt.unmet_ratified_measures), ['M-C']);
  assert.deepEqual(r.receipt.missing_reviews_from, [R2]);
  assert.ok(!r.receipt.ratified_by.includes(R2));
  assert.deepEqual(ids(declaredMeasures(events)), ['M-A', 'M-B', 'M-C']);
});

test('case 2 — joins then silent: acknowledgment supplies no credit', () => {
  const { events, add } = ledger();
  add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'proposer' });
  assert.equal(r.outcome, 'failed-safely');
  assert.deepEqual(ids(r.receipt.unmet_ratified_measures), ['M-A', 'M-B', 'M-C']);
  assert.deepEqual(r.receipt.ratified_measures, []);
});

test('case 3 — objection: A ratified and C objected → failed-safely, C named, A still listed, objection blocks', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, { measures: ['M-A'] });
  add(R2, 'object', 11, { reason: 'the run is red on Windows', measures: ['M-C'] });
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'stall' });
  assert.equal(r.outcome, 'failed-safely');
  assert.deepEqual(r.receipt.objected_measures.map(o => ({ id: o.id, by: o.by, reason: o.reason })),
    [{ id: 'M-C', by: R2, reason: 'the run is red on Windows' }]);
  assert.deepEqual(ids(r.receipt.ratified_measures), ['M-A']);
  assert.deepEqual(ids(r.receipt.unmet_ratified_measures), ['M-B']);
});

test('case 5a — no proposer before stall, one ratified → complete-to-authority-boundary, note names the stall route', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, { measures: ['M-A'] });
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'stall' });
  assert.equal(r.outcome, 'complete-to-authority-boundary');
  assert.deepEqual(ids(r.receipt.ratified_measures), ['M-A']);
  assert.deepEqual(ids(r.receipt.unmet_ratified_measures), ['M-B', 'M-C']);
  assert.match(r.receipt.note, /stall/);
  assert.match(r.receipt.note, /not a consensus/);
});

test('case 5b — no proposer, no verdicts → failed-safely with every measure unmet', () => {
  const { events } = ledger();
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'stall' });
  assert.equal(r.outcome, 'failed-safely');
  assert.deepEqual(ids(r.receipt.unmet_ratified_measures), ['M-A', 'M-B', 'M-C']);
});

test('case 5c — a legacy no-measure ledger has no contract to compute', () => {
  const { events } = ledger({ measures: null });
  assert.deepEqual(declaredMeasures(events), []);
  assert.equal(computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'stall' }), null);
});

test('case 7 — scoped verdict credits A only; a non-owed participant\'s bare ratify is whole-synthesis only', () => {
  const { events, add } = ledger();
  const pc = add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  add(R1, 'ratify', 21, { measures: ['M-A'] }, [pc.event_id]);
  add(Q, 'ratify', 22, {}, [pc.event_id]);
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'proposer' });
  assert.deepEqual(ids(r.receipt.ratified_measures), ['M-A']);
  assert.deepEqual(ids(r.receipt.unmet_ratified_measures), ['M-B', 'M-C']);
  assert.ok(r.receipt.ratified_by.includes(Q), 'Q ratified the synthesis');
  const v = measureVerdicts(events, iso(T0 + 60 * MIN));
  for (const [, m] of v) assert.ok(!m.ratified.some(x => x.by === Q), 'Q must never receive measure credit');
});

test('proposer route — every measure ratified and the synthesis converged → converged', () => {
  const { events, add } = ledger();
  const pc = add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  add(R1, 'ratify', 21, { measures: ['M-A', 'M-B'] }, [pc.event_id]);
  add(R2, 'ratify', 22, { measures: ['M-C'] }, [pc.event_id]);
  add(Q, 'ratify', 23, {}, [pc.event_id]);
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'proposer' });
  assert.equal(r.outcome, 'converged');
  // control: the stall route never claims converged even with everything ratified
  assert.equal(computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'stall' }).outcome, 'complete-to-authority-boundary');
});

test('sequence — ratify A, object B, then propose-close: the earlier objection still blocks', () => {
  const { events, add } = ledger();
  add(R1, 'ratify', 10, { measures: ['M-A'] });
  add(R1, 'object', 11, { reason: 'B duplicates collab-owned rules', measures: ['M-B'] });
  add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  const r = computeCloseOutcome(events, iso(T0 + 60 * MIN), { route: 'proposer' });
  assert.equal(r.outcome, 'failed-safely');
  assert.deepEqual(ids(r.receipt.objected_measures), ['M-B']);
});

// ---------------------------------------------------------------- replay: the 1.1.0 measured ledger

test('replay — a measured ledger with bare post-proposal verdicts computes the same unmet list as 3b97ac6', () => {
  // Expected values were computed by the 3b97ac6 reader (author-wide, post-propose-close):
  // R1's bare ratify discharges M-A and M-B; R2's bare object discharges M-C; nothing unmet.
  const { events, add } = ledger();
  const pc = add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  add(R1, 'ratify', 21, {}, [pc.event_id]);
  add(R2, 'object', 22, { reason: 'not yet' }, [pc.event_id]);
  assert.deepEqual(unmetRequiredReviews(events, iso(T0 + 60 * MIN)), []);
  const v = measureVerdicts(events, iso(T0 + 60 * MIN));
  assert.equal(v.get('M-C').objected[0].scope, 'legacy');
});
