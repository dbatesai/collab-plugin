/**
 * test-collab-replay-legacy.mjs — eligibility v1 leaves the past alone.
 *
 * Two ledgers written before this release, read by the new reader, must compute what the
 * 3b97ac6 reader computed. The expectations were produced by running that reader and are
 * stored beside the fixtures; nothing here was typed from memory.
 *
 * Fixture 1 — the July 31 stall (`tests/fixtures/2026-07-31-legacy-stall`): the real ledger,
 * structure-preserving. The machine name in every triplet is replaced by `host` and each
 * prose body is cut to its heading line; every field the reader consults (ids, timestamps,
 * types, authors, references, payload shapes) is unchanged.
 *
 * Fixture 2 — a synthetic 1.1.0 measured ledger with bare verdicts, the shape the old
 * writer produced when measures existed but verdicts did not name them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Dynamic so the preservation tests still run against a reader that lacks the new exports:
// there they pass, and only the tests that name the new reader fail.
const H = await import('../skills/collab/scripts/collab-event-helpers.mjs');
const {
  readEvents, checkSafetyNets, unmetRequiredReviews, getRatificationStatus, requiredReviewers, getTickIntervalMs,
  evaluateObligations, declaredMeasures, measureVerdicts, computeCloseOutcome, openRequests, waitCycles,
} = H;
const { detectRoute } = await import('../skills/collab/scripts/collab-tick.mjs');
const { validateEvents } = await import('../skills/collab/scripts/collab-validate.mjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', '2026-07-31-legacy-stall');

test('replay/july-31: the stall ledger closes exactly as 3b97ac6 closed it', () => {
  const expected = JSON.parse(readFileSync(join(FIX, 'expected-3b97ac6.json'), 'utf8'));
  const events = readEvents(FIX);
  const close = events.find(e => e.type === 'close');
  const before = events.filter(e => e !== close);
  const nowTs = close.ts;
  assert.equal(events.length, expected.events);
  assert.equal(close.payload.outcome, expected.close_outcome);
  assert.equal(getTickIntervalMs(events), expected.tick_ms);
  assert.equal(checkSafetyNets(before, nowTs), expected.net_at_close);
  assert.equal(detectRoute(before, close.author, nowTs), expected.route_at_close);
  assert.deepEqual(unmetRequiredReviews(before, nowTs), expected.unmet);
  assert.deepEqual(requiredReviewers(before), expected.required);
  assert.deepEqual(getRatificationStatus(before, nowTs), expected.ratification);
  assert.deepEqual(validateEvents(events).errors, []);
});

test('replay/july-31: no contract was ever declared, so the new reader computes none', () => {
  const events = readEvents(FIX);
  const close = events.find(e => e.type === 'close');
  const before = events.filter(e => e !== close);
  assert.deepEqual(declaredMeasures(before), []);
  assert.equal(measureVerdicts(before).size, 0);
  assert.equal(computeCloseOutcome(before, close.ts, { route: 'stall' }), null);
});

test('replay/july-31: what the new reader would have done differently — chased, and shown the wait', () => {
  // The old reader saw no obligations: no turn declared a deadline, so nobody was ever
  // chased, and the session sat 46 minutes before the stall net closed it. The new reader
  // gives every turn a deadline one cadence out, so at the close instant every last turn
  // is overdue: each participant's default fallback (proceed-alone) is due, the other
  // participants are also due a reminder, and nothing is flagged as an unbounded wait.
  const expected = JSON.parse(readFileSync(join(FIX, 'expected-3b97ac6.json'), 'utf8'));
  assert.deepEqual(expected.obligations_due_at_close, [], 'fixture drift: 3b97ac6 saw obligations here');
  const events = readEvents(FIX);
  const close = events.find(e => e.type === 'close');
  const before = events.filter(e => e !== close);
  const obl = evaluateObligations(before, { now: close.ts, self: close.author });
  const authors = [...new Set(before.filter(e => e.type === 'turn').map(e => e.author))];
  const others = authors.filter(a => a !== close.author);
  assert.deepEqual(obl.due.filter(d => d.action !== 'chase').map(d => [d.participant, d.action]).sort(), authors.map(a => [a, 'proceed-alone']).sort());
  assert.deepEqual(obl.due.filter(d => d.action === 'chase').map(d => d.participant).sort(), others.sort());
  assert.deepEqual(obl.invalid, [], 'the old reader flagged one turn as an unbounded wait; the default on_timeout removes that');
  // Those turns named `waiting_on` only as v0 prose; none carried the field, so no request is
  // visible and no cycle is reported — the reader invents nothing the writer did not say.
  assert.deepEqual(others.flatMap(a => openRequests(before, a)), []);
  assert.deepEqual(waitCycles(before), []);
});

// ---------------------------------------------------------------- the 1.1.0 measured ledger

const P = 'core-framework@claude-code:host';
const R1 = 'core-codex@codex:host';
const R2 = 'core-gemini@antigravity:host';
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 7, 1, 10, 0);
const iso = (ms) => new Date(ms).toISOString();

/** The shape 1.1.0 wrote: measures declared, verdicts bare, everything after the propose-close. */
export function measuredLegacyLedger() {
  const events = [];
  let n = 0;
  const add = (author, type, min, payload, references = []) => {
    const e = { event_id: `evt-${String(++n).padStart(3, '0')}`, ts: iso(T0 + min * MIN), author, slug: 'legacy-measured', type, references, payload };
    events.push(e);
    return e;
  };
  const ko = add(P, 'kickoff', 0, {
    message: 'm', igm: { intention: 'i', goal: 'g', measure: 'two adapters conform' }, capabilities_wanted: ['review'],
    wall_clock_hours: 24, transport: 'localhost', tick_interval_minutes: 5, ratification_window_minutes: 5,
    ratified_completion_measures: [
      { id: 'M-A', description: 'adapter A conforms', requires_review_from: R1 },
      { id: 'M-B', description: 'adapter B conforms', requires_review_from: R1 },
      { id: 'M-C', description: 'Windows run is clean', requires_review_from: R2 },
    ],
  });
  add(P, 'join', 0, { capability_match: [], commitment: 'own' }, [ko.event_id]);
  add(R1, 'join', 1, { capability_match: [], commitment: 'review' }, [ko.event_id]);
  add(R2, 'join', 2, { capability_match: [], commitment: 'review' }, [ko.event_id]);
  add(R1, 'ratify', 10, {});                                   // before any propose-close: not a verdict on anything
  const pc = add(P, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  add(R1, 'ratify', 21, {}, [pc.event_id]);
  add(R2, 'object', 22, { reason: 'not yet' }, [pc.event_id]);
  return { events, nowTs: iso(T0 + 60 * MIN), proposer: P };
}

test('replay/1.1.0-measured: bare verdicts after the propose-close compute the same unmet list and route as 3b97ac6', () => {
  const expected = JSON.parse(readFileSync(join(FIX, '..', 'legacy-measured-expected-3b97ac6.json'), 'utf8'));
  const { events, nowTs, proposer } = measuredLegacyLedger();
  assert.deepEqual(unmetRequiredReviews(events, nowTs), expected.unmet);
  assert.equal(detectRoute(events, proposer, nowTs), expected.route);
  assert.deepEqual(getRatificationStatus(events, nowTs), expected.ratification);
  assert.deepEqual(validateEvents(events).errors, expected.validation_errors);
  // The only observable difference is the label: each credit says it was read the legacy way.
  const v = measureVerdicts(events);
  assert.equal(v.get('M-A').ratified[0].scope, 'legacy');
  assert.equal(v.get('M-B').ratified[0].scope, 'legacy');
  assert.equal(v.get('M-C').objected[0].scope, 'legacy');
  assert.deepEqual(v.get('M-A').ratified.map(c => c.event_id), ['evt-007'], 'the pre-proposal ratify (evt-005) must not be the credit');
});
