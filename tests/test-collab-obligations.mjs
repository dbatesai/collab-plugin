/**
 * test-collab-obligations.mjs — DG3 failure classes 12 and 17.
 *
 * 12: a missed lease must escalate through chase to the DECLARED timeout action, and the
 *     action must EXECUTE — not merely be reported as due.
 * 17: chases are not progress. K cycles producing only bookkeeping must escalate the goal.
 *
 * Live motivation: this project's own session. A peer went quiet, the tick emitted its three
 * chases, hit the flood limit, and then said nothing further. Nothing executed a timeout
 * policy and nothing escalated, so the only thing that actually moved the goal forward was a
 * human noticing and relaying between agents. An overdue scanner that reports forever is a
 * silent stall wearing a badge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent, readEvents,
  evaluateObligations, executeTimeoutAction, OBLIGATION_GRACE_MS, CHASE_FLOOD_LIMIT,
} from '../skills/collab/scripts/collab-event-helpers.mjs';

const SLUG = 'obligation-channel';
const ME = 'core-framework@claude-code:host';
const PEER = 'core-codex@codex:host';
const T0 = Date.parse('2026-07-30T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

function mkChannel() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-oblig-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, { event_id: 'evt-kick', ts: iso(T0), author: ME, slug: SLUG, type: 'kickoff', references: [], payload: {} });
  appendEvent(dir, { event_id: 'evt-join', ts: iso(T0), author: PEER, slug: SLUG, type: 'join', references: [], payload: {} });
  return dir;
}

/** A peer turn that declares a deadline and what to do when it lapses. */
function peerTurn(dir, id, atMs, { deadline, onTimeout = 'proceed-alone' }) {
  appendEvent(dir, {
    event_id: id, ts: iso(atMs), author: PEER, slug: SLUG, type: 'turn', references: [],
    payload: {
      schema_version: '1.0', intent: 'propose', body: 'work', signals: [],
      state: 'working', owner: ME, waiting_on: ME,
      provenance: { emit_mode: 'automated', harness: 'codex' },
      next_update_by: iso(deadline), on_timeout: onTimeout, work_packet: 'WP-x',
    },
  });
}

function chase(dir, id, atMs) {
  appendEvent(dir, {
    event_id: id, ts: iso(atMs), author: ME, slug: SLUG, type: 'turn', references: [],
    payload: {
      schema_version: '1.0', intent: 'chase', body: 'you owe an update', signals: ['chase', 'obligation-missed', PEER],
      state: 'blocked', owner: PEER, waiting_on: PEER,
      provenance: { emit_mode: 'automated', harness: 'claude-code' },
      next_update_by: '',
    },
  });
}

// ---------------------------------------------------------------- class 12

test('12: before the deadline nothing is due; at the deadline the declared fallback is due — the chase waits for grace', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000 });
    assert.deepEqual(evaluateObligations(readEvents(dir), { now: T0 + 59_000, self: ME }).due, [], 'raised an obligation before the deadline');
    const at = evaluateObligations(readEvents(dir), { now: T0 + 60_000, self: ME });
    assert.deepEqual(at.due.map(d => d.action), ['proceed-alone'], 'the first check at the deadline must take the declared fallback, and only that');
    assert.equal(at.due[0].participant, PEER);
    assert.equal(at.due[0].for_deadline, iso(T0 + 60_000));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: past grace, the fallback is still due (unsettled) and a chase is due beside it — the reminder never replaces the bound', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000 });
    const r = evaluateObligations(readEvents(dir), { now: T0 + 60_000 + OBLIGATION_GRACE_MS + 1_000, self: ME });
    assert.deepEqual(r.due.map(d => d.action), ['proceed-alone', 'chase'], 'fallback first, then the reminder');
    assert.ok(r.due.every(d => d.participant === PEER));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: once the fallback has executed, later checks chase (bounded) but never re-execute it', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000 });
    const first = evaluateObligations(readEvents(dir), { now: T0 + 60_000, self: ME });
    executeTimeoutAction(dir, first.due[0], ME);
    const later = evaluateObligations(readEvents(dir), { now: T0 + 60_000 + OBLIGATION_GRACE_MS + 1_000, self: ME });
    assert.deepEqual(later.due.map(d => d.action), ['chase']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: once chases are exhausted, the DECLARED timeout action becomes due', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000, onTimeout: 'proceed-alone' });
    for (let i = 0; i < CHASE_FLOOD_LIMIT; i++) chase(dir, `evt-c${i}`, T0 + 120_000 + i * 60_000);

    const r = evaluateObligations(readEvents(dir), { now: T0 + 600_000, self: ME });
    assert.equal(r.due.length, 1);
    assert.equal(
      r.due[0].action, 'proceed-alone',
      `after ${CHASE_FLOOD_LIMIT} chases the declared on_timeout must become due, got ${r.due[0].action}. ` +
      'Chasing forever is the silent stall this class exists to prevent.',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: the timeout action EXECUTES and is recorded — reporting it is not enough', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000, onTimeout: 'degrade-and-continue' });
    for (let i = 0; i < CHASE_FLOOD_LIMIT; i++) chase(dir, `evt-c${i}`, T0 + 120_000 + i * 60_000);

    const before = readEvents(dir).length;
    const r = evaluateObligations(readEvents(dir), { now: T0 + 600_000, self: ME });
    const executed = executeTimeoutAction(dir, r.due[0], ME);

    assert.ok(executed, 'executeTimeoutAction returned nothing — the policy was computed but never applied');
    const after = readEvents(dir);
    assert.equal(after.length, before + 1, 'no event recorded for the executed timeout action');
    const rec = after.find(e => e.type === 'timeout-action');
    assert.ok(rec, 'the executed action left no routed record — an unobservable action is a silent one');
    assert.equal(rec.payload.action, 'degrade-and-continue');
    assert.equal(rec.payload.participant, PEER);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: an executed timeout action is not executed twice', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000 });
    for (let i = 0; i < CHASE_FLOOD_LIMIT; i++) chase(dir, `evt-c${i}`, T0 + 120_000 + i * 60_000);
    const first = evaluateObligations(readEvents(dir), { now: T0 + 600_000, self: ME });
    executeTimeoutAction(dir, first.due[0], ME);

    const second = evaluateObligations(readEvents(dir), { now: T0 + 900_000, self: ME });
    assert.deepEqual(
      second.due, [],
      'the timeout action came due again after already executing — a loop that re-fires policy forever',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: a waiting_on with an unrecognized on_timeout is rejected at evaluation, not silently skipped', () => {
  const dir = mkChannel();
  try {
    appendEvent(dir, {
      event_id: 'evt-bad', ts: iso(T0), author: PEER, slug: SLUG, type: 'turn', references: [],
      payload: {
        schema_version: '1.0', intent: 'propose', body: 'w', signals: [],
        state: 'blocked', owner: ME, waiting_on: ME,
        provenance: { emit_mode: 'automated', harness: 'codex' },
        next_update_by: iso(T0 + 60_000), on_timeout: 'panic',   // declared, and not in the vocabulary
      },
    });
    const r = evaluateObligations(readEvents(dir), { now: T0 + 600_000, self: ME });
    assert.ok(
      r.invalid.some(x => x.event_id === 'evt-bad'),
      'a wait with a deadline but an unrecognized timeout action passed unnoticed — that is an ' +
      'unbounded wait, which the design forbids outright',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('12: a waiting_on with NO on_timeout takes the default (proceed-alone) — an absence is not an error', () => {
  const dir = mkChannel();
  try {
    appendEvent(dir, {
      event_id: 'evt-abs', ts: iso(T0), author: PEER, slug: SLUG, type: 'turn', references: [],
      payload: {
        schema_version: '1.0', intent: 'propose', body: 'w', signals: [],
        state: 'blocked', owner: ME, waiting_on: ME,
        provenance: { emit_mode: 'automated', harness: 'codex' },
        next_update_by: iso(T0 + 60_000),
      },
    });
    for (let i = 0; i < CHASE_FLOOD_LIMIT; i++) chase(dir, `evt-c${i}`, T0 + 120_000 + i * 60_000);
    const r = evaluateObligations(readEvents(dir), { now: T0 + 600_000, self: ME });
    assert.deepEqual(r.invalid, []);
    assert.equal(r.due.find(d => d.participant === PEER)?.action, 'proceed-alone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- class 17

test('17: chases are not progress — a window of only chases escalates the goal', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000 });
    // Nothing but bookkeeping for a long stretch.
    for (let i = 0; i < 6; i++) chase(dir, `evt-c${i}`, T0 + 120_000 + i * 60_000);

    const r = evaluateObligations(readEvents(dir), { now: T0 + 900_000, self: ME });
    assert.ok(
      r.escalate,
      'a window containing only chase events did not escalate — the collaboration can look busy ' +
      'while producing nothing, which is exactly how a stall hides',
    );
    assert.match(String(r.escalate.reason), /progress|substantive/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('17: one substantive turn in the window resets progress — no false escalation', () => {
  const dir = mkChannel();
  try {
    peerTurn(dir, 'evt-p1', T0, { deadline: T0 + 60_000 });
    for (let i = 0; i < 6; i++) chase(dir, `evt-c${i}`, T0 + 120_000 + i * 60_000);
    peerTurn(dir, 'evt-p2', T0 + 800_000, { deadline: T0 + 1_800_000 });

    const r = evaluateObligations(readEvents(dir), { now: T0 + 900_000, self: ME });
    assert.ok(
      !r.escalate,
      'escalated despite real work landing in the window — false escalations train everyone to ignore them',
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
