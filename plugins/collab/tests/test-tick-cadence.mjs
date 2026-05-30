import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getTickIntervalMs,
  checkSafetyNets,
  getRatificationStatus,
  TICK_INTERVAL_MS,
} from '../skills/collab/scripts/collab-event-helpers.mjs';

const T0 = '2026-05-25T10:00:00Z';

function kickoff(extraPayload = {}) {
  return {
    event_id: 'evt-001', ts: T0, author: 'a@cc:m1', slug: 's', type: 'kickoff', references: [],
    payload: {
      message: 't',
      igm: { intention: 'i', goal: 'g', measure: 'm' },
      capabilities_wanted: [],
      wall_clock_hours: 24,
      ...extraPayload,
    },
  };
}

const JOIN_A = { event_id: 'evt-002', ts: T0, author: 'a@cc:m1', slug: 's', type: 'join', references: [],
  payload: { capability_match: [], commitment: 'self' } };
const JOIN_B = { event_id: 'evt-003', ts: T0, author: 'b@cc:m2', slug: 's', type: 'join', references: [],
  payload: { capability_match: [], commitment: 'peer' } };

// --- getTickIntervalMs ---

test('getTickIntervalMs: returns default 30m when field absent', () => {
  const events = [kickoff()];
  assert.equal(getTickIntervalMs(events), 30 * 60 * 1000);
  assert.equal(getTickIntervalMs(events), TICK_INTERVAL_MS);
});

test('getTickIntervalMs: returns 5m when kickoff declares it', () => {
  const events = [kickoff({ tick_interval_minutes: 5 })];
  assert.equal(getTickIntervalMs(events), 5 * 60 * 1000);
});

test('getTickIntervalMs: returns 10m when kickoff declares it', () => {
  const events = [kickoff({ tick_interval_minutes: 10 })];
  assert.equal(getTickIntervalMs(events), 10 * 60 * 1000);
});

test('getTickIntervalMs: falls back to default on invalid values', () => {
  assert.equal(getTickIntervalMs([kickoff({ tick_interval_minutes: 0 })]), TICK_INTERVAL_MS);
  assert.equal(getTickIntervalMs([kickoff({ tick_interval_minutes: -5 })]), TICK_INTERVAL_MS);
  assert.equal(getTickIntervalMs([kickoff({ tick_interval_minutes: 'fast' })]), TICK_INTERVAL_MS);
});

test('getTickIntervalMs: returns default when no kickoff present', () => {
  assert.equal(getTickIntervalMs([]), TICK_INTERVAL_MS);
});

// --- checkSafetyNets stall scaling ---

test('stall scales: 5-min cadence trips stall at 30 min, not 3 hours', () => {
  // 5-min cadence × 6 ticks = 30 min stall threshold
  const events = [kickoff({ tick_interval_minutes: 5 }), JOIN_A];
  // 31 min after last event → stall should fire
  assert.equal(checkSafetyNets(events, '2026-05-25T10:31:00Z'), 'stall');
  // 29 min after last event → still healthy
  assert.equal(checkSafetyNets(events, '2026-05-25T10:29:00Z'), null);
});

test('stall scales: 5-min cadence does NOT trip stall at 91 min (would on default)', () => {
  // Sanity check: at default 30-min cadence the 3-hour threshold (180 min) wouldn't fire at 91min,
  // but at 5-min cadence the 30-min threshold has long since passed. We assert the 5-min cadence
  // fires earlier than the default-30 cadence would.
  const fast = [kickoff({ tick_interval_minutes: 5 }), JOIN_A];
  const slow = [kickoff(), JOIN_A];
  assert.equal(checkSafetyNets(fast, '2026-05-25T11:31:00Z'), 'stall');  // 91 min — well past 30
  assert.equal(checkSafetyNets(slow, '2026-05-25T11:31:00Z'), null);      // 91 min — short of 180
});

test('stall scales: default cadence (no field) trips at 3 hours (backward compat)', () => {
  const events = [kickoff(), JOIN_A];
  assert.equal(checkSafetyNets(events, '2026-05-25T13:05:00Z'), 'stall');
  assert.equal(checkSafetyNets(events, '2026-05-25T11:30:00Z'), null);
});

// --- getRatificationStatus silence-ratify scaling ---

test('silence-ratify scales: 5-min cadence ratifies silence at 15+ min', () => {
  const events = [
    kickoff({ tick_interval_minutes: 5 }),
    JOIN_A, JOIN_B,
    { event_id: 'evt-004', ts: T0, author: 'a@cc:m1', slug: 's', type: 'propose-close', references: [],
      payload: { synthesis: 'done', igm_met: {} } },
  ];
  // 14 min after propose-close — under 15-min window
  let r = getRatificationStatus(events, '2026-05-25T10:14:00Z');
  assert.equal(r.converged, false, '14 min < 15 min window — silent peer still pending');
  assert.deepEqual(r.implicitRatified, []);
  assert.ok(r.pending.includes('b@cc:m2'));

  // 16 min after propose-close — past 15-min window
  r = getRatificationStatus(events, '2026-05-25T10:16:00Z');
  assert.equal(r.converged, true, '16 min > 15 min window — silent peer auto-ratified');
  assert.deepEqual(r.implicitRatified, ['b@cc:m2']);
});

test('silence-ratify scales: 10-min cadence ratifies silence at 30+ min', () => {
  const events = [
    kickoff({ tick_interval_minutes: 10 }),
    JOIN_A, JOIN_B,
    { event_id: 'evt-004', ts: T0, author: 'a@cc:m1', slug: 's', type: 'propose-close', references: [],
      payload: { synthesis: 'done', igm_met: {} } },
  ];
  // 29 min after propose-close — under 30-min window
  let r = getRatificationStatus(events, '2026-05-25T10:29:00Z');
  assert.equal(r.converged, false);
  // 31 min after propose-close — past 30-min window
  r = getRatificationStatus(events, '2026-05-25T10:31:00Z');
  assert.equal(r.converged, true);
});

test('silence-ratify default cadence still ratifies at 90+ min (backward compat)', () => {
  const events = [
    kickoff(),
    JOIN_A, JOIN_B,
    { event_id: 'evt-004', ts: T0, author: 'a@cc:m1', slug: 's', type: 'propose-close', references: [],
      payload: { synthesis: 'done', igm_met: {} } },
  ];
  // 89 min — short of default 90-min window
  let r = getRatificationStatus(events, '2026-05-25T11:29:00Z');
  assert.equal(r.converged, false);
  // 91 min — past default 90-min window
  r = getRatificationStatus(events, '2026-05-25T11:31:00Z');
  assert.equal(r.converged, true);
});
