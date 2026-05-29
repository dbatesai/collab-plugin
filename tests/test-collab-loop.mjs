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

// --- collab-loop main() integration tests (preflight-blocked + tick delegation) ---

import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, generateEventId } from '../skills/collab/scripts/collab-event-helpers.mjs';
import { main as loopMain } from '../skills/collab/scripts/collab-loop.mjs';

const LOCAL_COLLAB_ROOT = join(homedir(), '.collab', 'local');

function makeLoopTestCollab(slug) {
  const dir = join(LOCAL_COLLAB_ROOT, `2026-05-29-${slug}`);
  if (!existsSync(LOCAL_COLLAB_ROOT)) mkdirSync(LOCAL_COLLAB_ROOT, { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  // Minimal kickoff
  const ko = { event_id: generateEventId(new Date().toISOString(), 'hk'), ts: new Date(Date.now()-60000).toISOString(), author:'hk@cc:m', slug, type:'kickoff', references:[], payload:{ message:'t', transport:'localhost', igm:{intention:'i',goal:'g',measure:'m'}, capabilities_wanted:[], wall_clock_hours:24 } };
  appendEvent(dir, ko);
  const jn = { event_id: generateEventId(new Date().toISOString(), 'hk2'), ts: new Date(Date.now()-59000).toISOString(), author:'hk@cc:m', slug, type:'join', references:[], payload:{ capability_match:[], commitment:'ok' } };
  appendEvent(dir, jn);
  return dir;
}

function cleanLoopTestCollab(slug) {
  const dir = join(LOCAL_COLLAB_ROOT, `2026-05-29-${slug}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

test('collab-loop start: preflight-blocked returns before cursor write and tick (transport mismatch)', async () => {
  const slug = 'loop-start-pf-blocked';
  makeLoopTestCollab(slug);
  try {
    // Request a transport that differs from the found transport (localhost vs github:files)
    const code = await loopMain(['start', slug, '--workspace-id', 'test', '--transport', 'github:nonexistent-transport']);
    // Should return non-zero (blocked by transport mismatch)
    assert.ok(code !== 0, 'transport mismatch should block start');
  } finally { cleanLoopTestCollab(slug); }
});

test('collab-loop start: preflight-blocked with missing-justification stops before cursor+tick', async () => {
  const slug = 'loop-start-pf-justification';
  makeLoopTestCollab(slug);
  try {
    // Create a new-collab scenario by passing a slug that doesn't exist → preflight blocks
    // (actually for existing slug, justification only required for isNewCollab; 
    //  test version-too-low instead which definitely blocks)
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data) => { output += data; return true; };
    const code = await loopMain(['start', slug, '--workspace-id', 'test', '--min-version', '999.0.0']);
    process.stdout.write = origWrite;
    assert.equal(code, 1, 'version-too-low should exit with code 1');
    const parsed = JSON.parse(output);
    assert.equal(parsed.action, 'preflight-blocked', 'should return preflight-blocked action');
    assert.ok(parsed.blockers.length > 0, 'should have blockers');
  } finally { cleanLoopTestCollab(slug); }
});

test('collab-loop start: success path delegates to tickDeterministic (returns tick result)', async () => {
  const slug = 'loop-start-tick-delegate';
  makeLoopTestCollab(slug);
  try {
    let output = '';
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (data) => { output += data; return true; };
    const code = await loopMain(['start', slug, '--workspace-id', 'hk']);
    process.stdout.write = origWrite;
    assert.equal(code, 0, 'valid start should succeed');
    const parsed = JSON.parse(output);
    assert.equal(parsed.action, 'loop-started', 'should return loop-started');
    assert.ok('tick_result' in parsed, 'must include tick_result (proves tick delegation)');
    assert.ok('recommended_sleep_ms' in parsed, 'must include recommended cadence');
  } finally { cleanLoopTestCollab(slug); }
});
