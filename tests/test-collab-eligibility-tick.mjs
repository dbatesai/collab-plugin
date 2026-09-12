/**
 * test-collab-eligibility-tick.mjs — eligibility v1 at the tick.
 *
 * The tick is where the read-time semantics become a written record: the stall net and
 * the authority-boundary route share one outcome calculation; an invalid contract is
 * refused at the second distinct join; requests on the ticking participant and mutual
 * waits are surfaced in the result; a new wait cycle is recorded once per pair.
 *
 * Channels live under ~/.collab/local (localhost transport, so no git). Time is driven by
 * backdating timestamps relative to Date.now(), because the tick reads the real clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as H from '../skills/collab/scripts/collab-event-helpers.mjs';
const { appendEvent, readEvents } = H;
import { tickDeterministic } from '../skills/collab/scripts/collab-tick.mjs';

process.env.COLLAB_STATE_ROOT = mkdtempSync(join(tmpdir(), 'collab-state-'));

const ME = 'core-framework@claude-code:host';
const R1 = 'core-codex@codex:host';
const R2 = 'core-gemini@antigravity:host';
const LOCAL_COLLAB_ROOT = join(homedir(), '.collab', 'local');
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const MEASURES = [
  { id: 'M-A', description: 'adapter A conforms', requires_review_from: R1 },
  { id: 'M-B', description: 'adapter B conforms', requires_review_from: R1 },
  { id: 'M-C', description: 'Windows run is clean', requires_review_from: R2 },
];
// A declaration this plugin's writer would refuse — on disk only by hand edit or an older writer.
const BAD = [{ id: 'M-A', description: "(measure inferred as 'reasonable consensus on goal'; refine in first turn)", requires_review_from: R1 }];

/** A channel on disk. `measures: null` is the legacy shape; joins are R1 + R2 unless told otherwise. */
function mkChannel(slug, T0, { measures = MEASURES, joins = [R1, R2], capabilities = ['review'] } = {}) {
  const dir = join(LOCAL_COLLAB_ROOT, `2026-09-11-${slug}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  let n = 0;
  const add = (author, type, min, payload, references = [], { raw = false } = {}) => {
    const e = { event_id: `evt-${String(++n).padStart(3, '0')}`, ts: iso(T0 + min * MIN), author, slug, type, references, payload };
    // `raw` lands the file the way a hand edit or an older writer would — past this plugin's gate.
    if (raw) writeFileSync(join(dir, 'events', `${e.event_id}.json`), JSON.stringify(e, null, 2));
    else appendEvent(dir, e);
    return e;
  };
  const ko = { message: 'm', transport: 'localhost', igm: { intention: 'i', goal: 'g', measure: 'x' }, capabilities_wanted: capabilities, wall_clock_hours: 24, tick_interval_minutes: 5, ratification_window_minutes: 5 };
  if (measures) ko.ratified_completion_measures = measures;
  const k = add(ME, 'kickoff', 0, ko, [], { raw: measures === BAD });
  add(ME, 'join', 0, { capability_match: [], commitment: 'own' }, [k.event_id]);
  for (const a of joins) {
    const owes = (measures || []).filter(m => m.requires_review_from === a).map(m => m.id);
    add(a, 'join', 1, { capability_match: [], commitment: 'review', ...(owes.length ? { owes_review: owes } : {}) }, [k.event_id]);
  }
  return { dir, add };
}
const cleanup = (slug) => rmSync(join(LOCAL_COLLAB_ROOT, `2026-09-11-${slug}`), { recursive: true, force: true });
const tick = (slug, dryRun = true) => tickDeterministic(slug, { workspaceId: 'test', triplet: ME, dryRun });
const ids = (list) => (list || []).map(x => x.id).sort();

// ------------------------------------------------------------------ stall net

test('tick/stall: a measured session with one scoped ratify closes complete-to-authority-boundary, not aborted-stall', async () => {
  const slug = 'elig-tick-stall-ratified';
  const T0 = Date.now() - 90 * MIN;
  const { add } = mkChannel(slug, T0);
  try {
    add(R1, 'ratify', 10, { measures: ['M-A'] });                  // last event 80 min ago; stall net = 30 min
    const r = await tick(slug);
    assert.equal(r.action, 'close');
    assert.equal(r.reason, 'stall');
    assert.equal(r.event.payload.outcome, 'complete-to-authority-boundary');
    assert.deepEqual(ids(r.event.payload.ratified_measures), ['M-A']);
    assert.deepEqual(ids(r.event.payload.unmet_ratified_measures), ['M-B', 'M-C']);
    assert.deepEqual(r.event.payload.missing_reviews_from.sort(), [R1, R2].sort());
    assert.match(r.event.payload.note, /stall/);
    assert.match(r.event.payload.note, /not a consensus/);
  } finally { cleanup(slug); }
});

test('tick/stall: a measured session with no verdicts closes failed-safely with every measure unmet', async () => {
  const slug = 'elig-tick-stall-silent';
  const T0 = Date.now() - 90 * MIN;
  mkChannel(slug, T0);
  try {
    const r = await tick(slug);
    assert.equal(r.event.payload.outcome, 'failed-safely');
    assert.deepEqual(ids(r.event.payload.unmet_ratified_measures), ['M-A', 'M-B', 'M-C']);
  } finally { cleanup(slug); }
});

test('tick/stall: an objection anywhere makes the stall close failed-safely, with the objection named', async () => {
  const slug = 'elig-tick-stall-objected';
  const T0 = Date.now() - 90 * MIN;
  const { add } = mkChannel(slug, T0);
  try {
    add(R1, 'ratify', 10, { measures: ['M-A'] });
    add(R2, 'object', 11, { reason: 'red on Windows', measures: ['M-C'] });
    const r = await tick(slug);
    assert.equal(r.event.payload.outcome, 'failed-safely');
    assert.deepEqual(r.event.payload.objected_measures.map(o => [o.id, o.by, o.reason]), [['M-C', R2, 'red on Windows']]);
    assert.deepEqual(ids(r.event.payload.ratified_measures), ['M-A']);
  } finally { cleanup(slug); }
});

test('tick/stall: a legacy no-measure session still closes aborted-stall (control)', async () => {
  const slug = 'elig-tick-stall-legacy';
  const T0 = Date.now() - 90 * MIN;
  mkChannel(slug, T0, { measures: null, capabilities: [] });
  try {
    const r = await tick(slug);
    assert.equal(r.event.payload.outcome, 'aborted-stall');
    assert.equal(r.event.payload.unmet_ratified_measures, undefined, 'a legacy close carries no contract receipt');
  } finally { cleanup(slug); }
});

// ------------------------------------------------------------------ proposer route

test('tick/proposer: an objection recorded before the propose-close still blocks — the authority-boundary route closes failed-safely', async () => {
  const slug = 'elig-tick-proposer-earlier-objection';
  const T0 = Date.now() - 40 * MIN;
  const { add } = mkChannel(slug, T0);
  try {
    add(R1, 'object', 10, { reason: 'B duplicates collab-owned rules', measures: ['M-B'] });
    const pc = add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
    add(R1, 'ratify', 22, { measures: ['M-A'] }, [pc.event_id]);   // R2 silent; last event 18 min ago (no stall)
    const r = await tick(slug);
    assert.equal(r.action, 'close');
    assert.equal(r.reason, 'authority-boundary');
    assert.equal(r.event.payload.outcome, 'failed-safely');
    assert.deepEqual(ids(r.event.payload.objected_measures), ['M-B']);
    assert.deepEqual(ids(r.event.payload.unmet_ratified_measures), ['M-C']);
    assert.deepEqual(r.event.payload.missing_reviews_from, [R2]);
  } finally { cleanup(slug); }
});

test('tick/proposer: every measure scoped-ratified and the synthesis ratified → converged', async () => {
  const slug = 'elig-tick-proposer-converged';
  const T0 = Date.now() - 40 * MIN;
  const { add } = mkChannel(slug, T0);
  try {
    const pc = add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
    add(R1, 'ratify', 21, { measures: ['M-A', 'M-B'] }, [pc.event_id]);
    add(R2, 'ratify', 22, { measures: ['M-C'] }, [pc.event_id]);
    const r = await tick(slug);
    assert.equal(r.action, 'close');
    assert.equal(r.event.payload.outcome, 'converged');
  } finally { cleanup(slug); }
});

// ------------------------------------------------------------------ contract-invalid

test('tick/contract-invalid: a second distinct join into an invalid declaration is refused, and nothing is written', async () => {
  const slug = 'elig-tick-contract-invalid';
  const T0 = Date.now() - 10 * MIN;
  const { dir } = mkChannel(slug, T0, { measures: BAD, joins: [R1] });
  try {
    const before = readEvents(dir).length;
    const r = await tick(slug, false);
    assert.equal(r.action, 'contract-invalid');
    assert.ok(r.errors.some(e => /completion-measure-placeholder: M-A/.test(e)), JSON.stringify(r.errors));
    assert.match(r.repair, /failed-safely/);
    assert.equal(readEvents(dir).length, before, 'the tick wrote into a session whose contract is invalid');
  } finally { cleanup(slug); }
});

test('tick/contract-invalid: only the proposer joined → not yet triggered; the same participant joining twice → not triggered', async () => {
  const slug = 'elig-tick-contract-invalid-single';
  const T0 = Date.now() - 10 * MIN;
  const { add } = mkChannel(slug, T0, { measures: BAD, joins: [] });
  try {
    assert.notEqual((await tick(slug)).action, 'contract-invalid');
    add(ME, 'join', 2, { capability_match: [], commitment: 'own again' });
    assert.notEqual((await tick(slug)).action, 'contract-invalid');
  } finally { cleanup(slug); }
});

test('tick/contract-invalid: absent measures never trigger it', async () => {
  const slug = 'elig-tick-contract-absent';
  const T0 = Date.now() - 10 * MIN;
  mkChannel(slug, T0, { measures: null, capabilities: [] });
  try {
    assert.notEqual((await tick(slug)).action, 'contract-invalid');
  } finally { cleanup(slug); }
});

// ------------------------------------------------------------------ requests and wait cycles

const turn = (owner, waitingOn, extra = {}) => ({ intent: 'probe', body: 'please', signals: [], state: 'blocked', owner, waiting_on: waitingOn, ...extra });

test('tick/requests: the result lists open requests on the ticking participant, and the cycle it is part of', async () => {
  const slug = 'elig-tick-open-requests';
  const T0 = Date.now() - 10 * MIN;
  const { add } = mkChannel(slug, T0);
  try {
    const rMe = add(ME, 'turn', 2, turn(R1, R1, { next_update_by: iso(T0 + 60 * MIN), on_timeout: 'proceed-alone' }));
    const rR1 = add(R1, 'turn', 3, turn(ME, ME, { body: 'I need your fixture first' }));
    const r = await tick(slug);
    assert.equal(r.action, 'agent-decision-needed');
    assert.deepEqual(r.open_requests.map(x => [x.request_id, x.from, x.state]), [[rR1.event_id, R1, 'requested']]);
    assert.equal(r.open_requests[0].deadline, iso(T0 + 8 * MIN), 'a request with no deadline defaults to its timestamp plus one cadence');
    assert.equal(r.wait_cycles.length, 1);
    assert.deepEqual(r.wait_cycles[0].requests, [rMe.event_id, rR1.event_id].sort());
  } finally { cleanup(slug); }
});

test('tick/requests: a new wait cycle is recorded as one system turn per pair, never twice for the same pair', async () => {
  const slug = 'elig-tick-wait-cycle-once';
  const T0 = Date.now() - 10 * MIN;
  const { dir, add } = mkChannel(slug, T0);
  try {
    // Deadlines still ahead: a pair whose bounds have both lapsed dissolves by lapse instead.
    add(ME, 'turn', 2, turn(R1, R1, { next_update_by: iso(T0 + 60 * MIN) }));
    add(R1, 'turn', 3, turn(ME, ME, { next_update_by: iso(T0 + 60 * MIN) }));
    await tick(slug, false);
    const cycleTurns = () => readEvents(dir).filter(e => e.type === 'turn' && (e.payload?.signals || []).includes('wait-cycle'));
    assert.equal(cycleTurns().length, 1);
    const sys = cycleTurns()[0];
    assert.equal(sys.author, ME);
    assert.ok(sys.payload.signals.includes(R1) && sys.payload.signals.includes(ME));
    assert.equal(sys.payload.waiting_on, null, 'the system turn must not itself be a request');
    await tick(slug, false);
    assert.equal(cycleTurns().length, 1, 'the same unchanged pair was recorded twice');
    // The system turn must not make the recorder look like it owes anything: no chase on ME.
    const chasesOnMe = readEvents(dir).filter(e => (e.payload?.signals || []).includes('chase') && e.payload.signals.includes(ME));
    assert.equal(chasesOnMe.length, 0);
  } finally { cleanup(slug); }
});

// ------------------------------------------------------------------ chase loop defaults

test('tick/deadline: the first tick at or after a defaulted deadline executes the default fallback and records it once; the reminder comes after grace', async () => {
  const slug = 'elig-tick-fallback-default';
  const T0 = Date.now() - 12 * MIN;
  const { dir, add } = mkChannel(slug, T0, { joins: [R1] });
  try {
    add(R1, 'turn', 5, turn(R1, null, { body: 'working on it' }));   // deadline T0+10; now = T0+12: past deadline, inside grace
    const first = await tick(slug, false);
    assert.equal(first.timeout_actions_executed, 1);
    assert.equal(first.chase_events_emitted, 0, 'a chase inside the grace window');
    const tas = () => readEvents(dir).filter(e => e.type === 'timeout-action' && e.payload?.participant === R1);
    assert.equal(tas().length, 1);
    assert.equal(tas()[0].payload.action, 'proceed-alone');
    assert.equal(tas()[0].payload.for_deadline, iso(T0 + 10 * MIN));
    const second = await tick(slug, false);
    assert.equal(second.timeout_actions_executed, 0, 'the same deadline executed twice');
    assert.equal(tas().length, 1);
  } finally { cleanup(slug); }
});

test('tick/deadline: an explicit deadline missed by an hour is taken at the first tick, and the reminder is emitted beside it', async () => {
  const slug = 'elig-tick-fallback-explicit';
  const T0 = Date.now() - 70 * MIN;
  const { dir, add } = mkChannel(slug, T0, { joins: [R1] });
  try {
    add(R1, 'turn', 5, turn(R1, null, { body: 'working', next_update_by: iso(T0 + 10 * MIN), on_timeout: 'reassign' }));
    add(ME, 'turn', 60, turn(ME, null, { body: 'keeping the channel out of the stall net', next_update_by: iso(T0 + 120 * MIN) }));
    const r = await tick(slug, false);
    assert.equal(r.timeout_actions_executed, 1);
    assert.equal(r.chase_events_emitted, 1);
    const ta = readEvents(dir).find(e => e.type === 'timeout-action' && e.payload?.participant === R1);
    assert.equal(ta.payload.action, 'reassign');
    assert.equal(ta.payload.for_deadline, iso(T0 + 10 * MIN));
  } finally { cleanup(slug); }
});

test('tick/deadline: the requester\'s own tick executes the requester\'s own bound — the recipient being offline is the case it exists for', async () => {
  const slug = 'elig-tick-fallback-own';
  const T0 = Date.now() - 12 * MIN;
  const { dir, add } = mkChannel(slug, T0, { joins: [R1] });
  try {
    const req = add(ME, 'turn', 5, turn(R1, R1, { body: 'please review M-A' }));   // ME's bound: T0+10, proceed-alone
    const r = await tick(slug, false);                                              // ME ticks; R1 is silent
    assert.equal(r.timeout_actions_executed, 1);
    assert.equal(r.chase_events_emitted, 0, 'nobody chases themselves');
    const ta = readEvents(dir).find(e => e.type === 'timeout-action');
    assert.equal(ta.payload.participant, ME);
    assert.deepEqual(readEvents(dir).filter(e => (e.payload?.signals || []).includes('chase')), []);
    // The request has lapsed for the recipient, and the measure is still unmet.
    assert.deepEqual(H.openRequests(readEvents(dir), R1), []);
    assert.equal(H.openRequests(readEvents(dir), R1, { includeClosed: true }).find(x => x.request_id === req.event_id).state, 'lapsed');
    assert.deepEqual(H.unmetRequiredReviews(readEvents(dir)).map(m => m.id), ['M-A', 'M-B', 'M-C']);
  } finally { cleanup(slug); }
});

test('tick/requests: a refused verdict that references a request does not deliver it — the request stays open in the tick result', async () => {
  const slug = 'elig-tick-refused-verdict-request';
  const T0 = Date.now() - 10 * MIN;
  const { add } = mkChannel(slug, T0);
  try {
    const req = add(R1, 'turn', 2, turn(ME, ME, { body: 'please confirm M-Z', next_update_by: iso(T0 + 60 * MIN), on_timeout: 'proceed-alone' }));
    // ME is not a named reviewer, so the gate lets this through; the reader must still not count it.
    add(ME, 'ratify', 3, { measures: ['M-Z'] }, [req.event_id], { raw: true });
    const r = await tick(slug);
    assert.deepEqual(r.open_requests.map(x => [x.request_id, x.state]), [[req.event_id, 'requested']]);
  } finally { cleanup(slug); }
});
