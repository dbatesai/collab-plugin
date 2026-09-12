/**
 * test-collab-eligibility-validate.mjs — eligibility v1, validator rules.
 *
 * Interpret by shape, guarantee at write. The validator refuses what is present and
 * invalid, warns on what is present and pointless, and says nothing about what is
 * absent — an absent `measures` field on a verdict is the legacy shape and is tolerated
 * here so a 1.1.0 ledger keeps validating exactly as it did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let validateEvents;
try { ({ validateEvents } = await import('../skills/collab/scripts/collab-validate.mjs')); }
catch { validateEvents = () => { throw new Error('not implemented'); }; }

const P = 'core-framework@claude-code:host';
const R1 = 'core-codex@codex:host';
const R2 = 'core-gemini@antigravity:host';
const Q = 'bblens@claude-code:work';

const MEASURES = [
  { id: 'M-A', description: 'adapter A conforms to the shared spec', requires_review_from: R1 },
  { id: 'M-B', description: 'adapter B conforms to the shared spec', requires_review_from: R1 },
  { id: 'M-C', description: 'Windows run is clean', requires_review_from: R2 },
];

let n = 0;
const ev = (author, type, payload, references = []) => ({
  event_id: `evt-${String(++n).padStart(3, '0')}`,
  ts: new Date(Date.UTC(2026, 8, 11, 10, n)).toISOString(),
  author, slug: 'elig', type, references, payload,
});

function contractLedger({ measures = MEASURES } = {}) {
  n = 0;
  const ko = ev(P, 'kickoff', {
    message: 'm', igm: { intention: 'i', goal: 'g', measure: 'three adapters conform' },
    capabilities_wanted: ['review'], wall_clock_hours: 24, transport: 'localhost',
    ratified_completion_measures: measures,
  });
  return [
    ko,
    ev(P, 'join', { capability_match: [], commitment: 'own' }, [ko.event_id]),
    ev(R1, 'join', { capability_match: [], commitment: 'review', owes_review: ['M-A', 'M-B'] }, [ko.event_id]),
    ev(R2, 'join', { capability_match: [], commitment: 'review', owes_review: ['M-C'] }, [ko.event_id]),
    ev(Q, 'join', { capability_match: [], commitment: 'observe' }, [ko.event_id]),
  ];
}

const errorsOf = (events) => validateEvents(events).errors;
const warningsOf = (events) => validateEvents(events).warnings;
const has = (list, re) => list.some(s => re.test(s));

// ------------------------------------------------------------------ kickoff measures

test('validator: a contract ledger with valid measures and acknowledgments has no errors', () => {
  assert.deepEqual(errorsOf(contractLedger()), []);
});

test('validator: placeholder description is refused by id', () => {
  const m = [{ ...MEASURES[0], description: "(measure inferred as 'reasonable consensus on goal'; refine in first turn)" }];
  const errs = errorsOf(contractLedger({ measures: m }));
  assert.ok(has(errs, /completion-measure-placeholder: M-A/), JSON.stringify(errs));
});

test('validator: empty description and duplicate id are refused by id', () => {
  assert.ok(has(errorsOf(contractLedger({ measures: [{ ...MEASURES[0], description: '' }] })), /completion-measure-invalid: M-A/));
  assert.ok(has(errorsOf(contractLedger({ measures: [MEASURES[0], { ...MEASURES[0], description: 'again' }] })), /completion-measure-invalid: M-A/));
});

// ------------------------------------------------------------------ join acknowledgment

test('validator: owes_review with an undeclared id is refused (measure-unknown)', () => {
  const events = contractLedger();
  events[2].payload.owes_review = ['M-A', 'M-Z'];
  const errs = errorsOf(events);
  assert.ok(has(errs, /measure-unknown: M-Z/), JSON.stringify(errs));
});

test('validator: owes_review naming another reviewer\'s measure is refused (owes-review-not-owed)', () => {
  const events = contractLedger();
  events[2].payload.owes_review = ['M-A', 'M-C'];
  const errs = errorsOf(events);
  assert.ok(has(errs, /owes-review-not-owed: M-C/), JSON.stringify(errs));
});

test('validator: a named reviewer who under-acknowledges gets a warning, not an error', () => {
  const events = contractLedger();
  events[2].payload.owes_review = ['M-A'];
  const r = validateEvents(events);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, /review-ack-mismatch: core-codex@codex:host/), JSON.stringify(r.warnings));
  // control: the full acknowledgment produces no such warning
  assert.ok(!has(warningsOf(contractLedger()), /review-ack-mismatch/));
});

// ------------------------------------------------------------------ verdict scoping

function withProposeClose(events) {
  const pc = ev(P, 'propose-close', { synthesis: 's', igm_met: {} });
  return { events: [...events, pc], pc };
}

test('validator: a scoped verdict on an undeclared id is refused (measure-unknown)', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', { measures: ['M-A', 'M-Z'] }, [pc.event_id]));
  assert.ok(has(errorsOf(events), /measure-unknown: M-Z/));
});

test('validator: a verdict claiming another reviewer\'s measure is refused (verdict-reviewer-mismatch)', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', { measures: ['M-C'] }, [pc.event_id]));
  assert.ok(has(errorsOf(events), /verdict-reviewer-mismatch: core-codex@codex:host M-C/));
});

test('validator: an empty measures array from a named reviewer is refused (verdict-unscoped)', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', { measures: [] }, [pc.event_id]));
  assert.ok(has(errorsOf(events), /verdict-unscoped: core-codex@codex:host owes M-A, M-B/));
});

test('validator: an ABSENT measures field from a named reviewer is the legacy shape and is not an error', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', {}, [pc.event_id]));
  assert.deepEqual(errorsOf(events), []);
});

test('validator: measures from a participant who owes nothing is a warning (verdict-measures-ignored)', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(Q, 'ratify', { measures: ['M-A'] }, [pc.event_id]));
  const r = validateEvents(events);
  assert.deepEqual(r.errors, []);
  assert.ok(has(r.warnings, /verdict-measures-ignored: bblens@claude-code:work/), JSON.stringify(r.warnings));
});

test('validator: a second verdict on an already-judged measure is refused whole (verdict-duplicate)', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', { measures: ['M-A'] }, [pc.event_id]));
  events.push(ev(R1, 'ratify', { measures: ['M-A', 'M-B'] }, [pc.event_id]));
  const errs = errorsOf(events);
  assert.ok(has(errs, /verdict-duplicate: core-codex@codex:host M-A/), JSON.stringify(errs));
});

test('validator: ratify then object on the same measure by the same reviewer is a duplicate', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', { measures: ['M-A'] }, [pc.event_id]));
  events.push(ev(R1, 'object', { reason: 'changed my mind', measures: ['M-A'] }, [pc.event_id]));
  assert.ok(has(errorsOf(events), /verdict-duplicate: core-codex@codex:host M-A/));
  // control: distinct measures by the same reviewer are two valid verdicts
  const { events: ok, pc: pc2 } = withProposeClose(contractLedger());
  ok.push(ev(R1, 'ratify', { measures: ['M-A'] }, [pc2.event_id]));
  ok.push(ev(R1, 'object', { reason: 'B is not done', measures: ['M-B'] }, [pc2.event_id]));
  assert.deepEqual(errorsOf(ok), []);
});

// ------------------------------------------------------------------ legacy replay

test('validator: a legacy ledger with no measures gets no eligibility errors for any verdict shape', () => {
  n = 0;
  const ko = ev(P, 'kickoff', { message: 'm', igm: { intention: 'i', goal: 'g', measure: "(measure inferred as 'reasonable consensus on goal'; refine in first turn)" }, capabilities_wanted: ['x'], wall_clock_hours: 24, transport: 'localhost' });
  const events = [ko, ev(R1, 'join', { capability_match: [], commitment: 'c' }, [ko.event_id])];
  const pc = ev(P, 'propose-close', { synthesis: 's', igm_met: {} });
  events.push(pc, ev(R1, 'ratify', {}, [pc.event_id]));
  // The placeholder IGM measure text is not a declared measure; legacy sessions never declared any.
  assert.deepEqual(errorsOf(events), []);
});

test('validator: a 1.1.0-shaped measured ledger with bare verdicts validates with no new errors', () => {
  const { events, pc } = withProposeClose(contractLedger());
  events.push(ev(R1, 'ratify', {}, [pc.event_id]));
  events.push(ev(R2, 'object', { reason: 'not yet' }, [pc.event_id]));
  assert.deepEqual(errorsOf(events), []);
  // control: the same ledger with one scoped verdict carrying an unknown id produces exactly one error
  events.push(ev(R1, 'ratify', { measures: ['M-Z'] }, [pc.event_id]));
  const errs = errorsOf(events);
  assert.equal(errs.length, 1, JSON.stringify(errs));
  assert.ok(has(errs, /measure-unknown: M-Z/));
});
