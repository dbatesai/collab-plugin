import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCadence, activateFastPollWindow, updateCommitmentTracking,
  cursorFilePath, deriveMachineSlug,
  BASE_CADENCE_MINUTES, FAST_POLL_SECONDS, IDLE_CADENCE_MINUTES,
  FAST_POLL_WINDOW_MINUTES, IDLE_THRESHOLD_MINUTES,
} from '../skills/collab/scripts/collab-cadence.mjs';

// --- computeCadence ---

test('computeCadence: base cadence when no activity and no fast-poll window', () => {
  const state = { fast_poll_window_expires_at: null };
  const result = computeCadence(state, null, new Date());
  assert.equal(result.mode, 'base');
  assert.equal(result.sleepMs, BASE_CADENCE_MINUTES * 60 * 1000);
  assert.match(result.reason, /base cadence/);
});

test('computeCadence: fast-poll mode when window is active', () => {
  const now = new Date();
  const state = {
    fast_poll_window_expires_at: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
  };
  const result = computeCadence(state, null, now);
  assert.equal(result.mode, 'fast-poll');
  assert.equal(result.sleepMs, FAST_POLL_SECONDS * 1000);
  assert.match(result.reason, /fast-poll window active/);
});

test('computeCadence: base mode when fast-poll window has expired', () => {
  const now = new Date();
  const state = {
    fast_poll_window_expires_at: new Date(now.getTime() - 60 * 1000).toISOString(),
  };
  const result = computeCadence(state, null, now);
  assert.equal(result.mode, 'base');
});

test('computeCadence: idle mode when last event over threshold', () => {
  const now = new Date();
  const longAgo = new Date(now.getTime() - (IDLE_THRESHOLD_MINUTES + 1) * 60 * 1000).toISOString();
  const state = { fast_poll_window_expires_at: null };
  const result = computeCadence(state, longAgo, now);
  assert.equal(result.mode, 'idle');
  assert.equal(result.sleepMs, IDLE_CADENCE_MINUTES * 60 * 1000);
});

test('computeCadence: base (not idle) when last event under threshold', () => {
  const now = new Date();
  const recentEnough = new Date(now.getTime() - (IDLE_THRESHOLD_MINUTES - 1) * 60 * 1000).toISOString();
  const state = { fast_poll_window_expires_at: null };
  const result = computeCadence(state, recentEnough, now);
  assert.equal(result.mode, 'base');
});

test('computeCadence: fast-poll takes priority over idle', () => {
  const now = new Date();
  const longAgo = new Date(now.getTime() - (IDLE_THRESHOLD_MINUTES + 10) * 60 * 1000).toISOString();
  const state = {
    fast_poll_window_expires_at: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
  };
  const result = computeCadence(state, longAgo, now);
  assert.equal(result.mode, 'fast-poll', 'fast-poll should take priority over idle');
});

// --- activateFastPollWindow ---

test('activateFastPollWindow: sets window to now + FAST_POLL_WINDOW_MINUTES', () => {
  const now = new Date();
  const state = {};
  activateFastPollWindow(state, now);
  assert.ok(state.fast_poll_window_expires_at, 'should set fast_poll_window_expires_at');
  const expires = new Date(state.fast_poll_window_expires_at);
  const expectedMs = FAST_POLL_WINDOW_MINUTES * 60 * 1000;
  assert.ok(
    Math.abs((expires - now) - expectedMs) < 1000,
    `window should be ~${FAST_POLL_WINDOW_MINUTES} minutes from now`,
  );
});

// --- updateCommitmentTracking ---

test('updateCommitmentTracking: records on-time when deadline is future', () => {
  const now = new Date();
  const state = {};
  const future = new Date(now.getTime() + 5 * 60 * 1000).toISOString();
  updateCommitmentTracking(state, { payload: { next_update_by: future } }, now);
  assert.equal(state.commitment_drift_state, 'on-time');
  assert.equal(state.commitment_drift_seconds, 0);
  assert.equal(state.last_committed_next_update_by, future);
});

test('updateCommitmentTracking: records missed when far past deadline', () => {
  const now = new Date();
  const state = {};
  const longPast = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  updateCommitmentTracking(state, { payload: { next_update_by: longPast } }, now);
  assert.equal(state.commitment_drift_state, 'missed');
  assert.ok(state.commitment_drift_seconds > 500, 'drift should be >500s for 10min late');
});

test('updateCommitmentTracking: records late when slightly past deadline', () => {
  const now = new Date();
  const state = {};
  const slightlyPast = new Date(now.getTime() - 2 * 60 * 1000).toISOString();
  updateCommitmentTracking(state, { payload: { next_update_by: slightlyPast } }, now);
  assert.equal(state.commitment_drift_state, 'late');
});

test('updateCommitmentTracking: no-op when no next_update_by field', () => {
  const state = {};
  updateCommitmentTracking(state, { payload: {} }, new Date());
  assert.equal(state.last_committed_next_update_by, undefined);
  assert.equal(state.commitment_drift_state, undefined);
});

// --- cursorFilePath ---

test('cursorFilePath: includes machine, harness, transport, and encoded triplet', () => {
  const triplet = 'core-framework@claude-code:Jennifer-Aniston';
  const path = cursorFilePath(triplet, 'my-slug', { machineSlug: 'test-machine', transport: 'github:files' });
  assert.ok(path.includes('test-machine'), 'should include machine slug');
  assert.ok(path.includes('claude-code'), 'should include harness');
  assert.ok(path.includes('github-files'), 'should include encoded transport');
  assert.ok(path.includes('my-slug'), 'should include collab slug');
  assert.ok(path.endsWith('.json'), 'should end with .json');
});

test('cursorFilePath: @ and : are not in filename (encoded)', () => {
  const triplet = 'core-framework@claude-code:Jennifer-Aniston';
  const path = cursorFilePath(triplet, 'slug', { machineSlug: 'machine', transport: 'localhost' });
  const filename = path.split('/').pop();
  assert.ok(!filename.includes('@'), 'filename should not contain @');
  assert.ok(!filename.includes(':'), 'filename should not contain :');
});

test('cursorFilePath: same triplet+slug on different transports → different paths (HC blocker #1)', () => {
  const triplet = 'core-framework@claude-code:Jennifer-Aniston';
  const localhost = cursorFilePath(triplet, 'slug', { machineSlug: 'm', transport: 'localhost' });
  const github = cursorFilePath(triplet, 'slug', { machineSlug: 'm', transport: 'github:files' });
  assert.notEqual(localhost, github, 'transport must disambiguate cursor identity — no collision');
});

test('cursorFilePath: back-compat with string machineSlug (3-arg signature)', () => {
  const triplet = 'core-framework@claude-code:m';
  const path = cursorFilePath(triplet, 'slug', 'legacy-machine');
  assert.ok(path.includes('legacy-machine'), 'string opts treated as machineSlug');
});
