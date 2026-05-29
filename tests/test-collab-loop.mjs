import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeObligations, renderStatusBlock } from '../skills/collab/scripts/collab-loop.mjs';

// Minimal event fixtures
function turnEvent(author, ts, payload = {}) {
  return { event_id: `evt-${ts}`, ts, author, type: 'turn', payload };
}
function joinEvent(author, ts) {
  return { event_id: `evt-join-${ts}`, ts, author, type: 'join', payload: {} };
}

test('computeObligations: on-time when committed deadline is future', () => {
  const now = '2026-05-29T05:00:00.000Z';
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:55:00.000Z', { next_update_by: '2026-05-29T05:30:00.000Z' }),
  ];
  const obs = computeObligations(events, now);
  assert.equal(obs.length, 1);
  assert.equal(obs[0].drift_state, 'on-time');
});

test('computeObligations: missed when past deadline + grace', () => {
  const now = '2026-05-29T05:00:00.000Z';
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:30:00.000Z', { next_update_by: '2026-05-29T04:50:00.000Z' }),
  ];
  const obs = computeObligations(events, now);
  assert.equal(obs[0].drift_state, 'missed', '10min past deadline + grace = missed');
});

test('computeObligations: late when just past deadline within grace', () => {
  const now = '2026-05-29T05:00:00.000Z';
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:30:00.000Z', { next_update_by: '2026-05-29T04:58:00.000Z' }),
  ];
  const obs = computeObligations(events, now);
  assert.equal(obs[0].drift_state, 'late', '2min past deadline within 5min grace = late');
});

test('computeObligations: unknown when no next_update_by committed', () => {
  const now = '2026-05-29T05:00:00.000Z';
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:55:00.000Z', {}),
  ];
  const obs = computeObligations(events, now);
  assert.equal(obs[0].drift_state, 'unknown');
});

test('computeObligations: tracks multiple participants independently', () => {
  const now = '2026-05-29T05:00:00.000Z';
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    joinEvent('b@codex:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:55:00.000Z', { next_update_by: '2026-05-29T05:30:00.000Z' }),
    turnEvent('b@codex:m', '2026-05-29T04:30:00.000Z', { next_update_by: '2026-05-29T04:40:00.000Z' }),
  ];
  const obs = computeObligations(events, now);
  const a = obs.find(o => o.participant === 'a@claude-code:m');
  const b = obs.find(o => o.participant === 'b@codex:m');
  assert.equal(a.drift_state, 'on-time');
  assert.equal(b.drift_state, 'missed');
});

test('renderStatusBlock: includes State/Owner/Waiting/Cadence lines', () => {
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:55:00.000Z', {
      state: 'working', owner: 'b@codex:m', waiting_on: 'b review',
      next_update_by: '2026-05-29T05:30:00.000Z',
    }),
  ];
  const cadence = { mode: 'base', sleepMs: 300000, reason: 'base cadence' };
  const obligations = computeObligations(events, '2026-05-29T05:00:00.000Z');
  const block = renderStatusBlock(events, 'test-slug', cadence, obligations);
  assert.match(block, /State:\s+working/);
  assert.match(block, /Owner:\s+b@codex:m/);
  assert.match(block, /Waiting on:\s+b review/);
  assert.match(block, /Cadence:\s+base/);
});

test('renderStatusBlock: flags missed obligations with warning marker', () => {
  const events = [
    joinEvent('a@claude-code:m', '2026-05-29T04:00:00.000Z'),
    turnEvent('a@claude-code:m', '2026-05-29T04:30:00.000Z', { next_update_by: '2026-05-29T04:40:00.000Z' }),
  ];
  const cadence = { mode: 'base', sleepMs: 300000, reason: 'base cadence' };
  const obligations = computeObligations(events, '2026-05-29T05:00:00.000Z');
  const block = renderStatusBlock(events, 'test-slug', cadence, obligations);
  assert.match(block, /MISSED/, 'should flag missed obligation');
});
