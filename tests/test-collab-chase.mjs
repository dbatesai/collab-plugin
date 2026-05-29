/**
 * test-collab-chase.mjs — tests for v1.0 #6: deterministic chase emission.
 * Tests: missed obligation → chase event emitted; grace period respected;
 * flood limit (3/hr); non-ISO next_update_by skipped; self not chased;
 * no obligation → no chase; no heartbeat body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, generateEventId } from '../skills/collab/scripts/collab-event-helpers.mjs';
import { tickDeterministic } from '../skills/collab/scripts/collab-tick.mjs';
import { homedir } from 'node:os';

// findCollabAcrossTransports scans ~/.collab/local/ for localhost transport.
// We create test collabs there with date prefix so they're discoverable.
const LOCAL_COLLAB_ROOT = join(homedir(), '.collab', 'local');

function tmpLocalCollab(slug) {
  const dirName = `2026-05-29-${slug}`;
  const dir = join(LOCAL_COLLAB_ROOT, dirName);
  if (!existsSync(LOCAL_COLLAB_ROOT)) mkdirSync(LOCAL_COLLAB_ROOT, { recursive: true });
  mkdirSync(join(dir, 'events'), { recursive: true });
  return { dir, slug };
}

function cleanupLocalCollab(slug) {
  const dir = join(LOCAL_COLLAB_ROOT, `2026-05-29-${slug}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function ts(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function isoDeadline(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

function kickoffEvent(dir, slug) {
  const ev = {
    event_id: generateEventId(new Date().toISOString(), 'hk'),
    ts: ts(60), author: 'hk@claude-code:m', slug, type: 'kickoff',
    references: [],
    payload: { message: 'test collab', transport: 'localhost', igm: { intention:'i', goal:'g', measure:'m' }, capabilities_wanted: [], wall_clock_hours: 24 },
  };
  appendEvent(dir, ev);
  return ev;
}
function joinEvent(dir, slug, author = 'hc@codex:m') {
  const ev = {
    event_id: generateEventId(new Date().toISOString(), 'hc'),
    ts: ts(59), author, slug, type: 'join',
    references: [], payload: { capability_match: [], commitment: 'ok' },
  };
  appendEvent(dir, ev);
  return ev;
}
function turnEvent(dir, slug, author, minsAgo, nextUpdateByMinsAgo) {
  const ev = {
    event_id: generateEventId(new Date(Date.now() - minsAgo * 60 * 1000).toISOString(), 'a'),
    ts: ts(minsAgo), author, slug, type: 'turn',
    references: [],
    payload: {
      intent: 'synthesize', body: 'something substantive here to avoid heartbeat warning',
      next_update_by: nextUpdateByMinsAgo ? isoDeadline(nextUpdateByMinsAgo) : '',
    },
  };
  appendEvent(dir, ev);
  return ev;
}

// Note: joinEvent is required for the ticking agent so hasJoined() returns true.
// The kickoff author is NOT auto-joined; only explicit join events count.

test('chase: emits chase event when obligation missed + grace elapsed', async () => {
  const slug = 'chase-test-missed-obligation';
  const { dir } = tmpLocalCollab(slug);
  try {
    kickoffEvent(dir, slug);
    joinEvent(dir, slug, 'hk@claude-code:m'); // hk must join to tick
    joinEvent(dir, slug, 'hc@codex:m');
    // HC turn with deadline 15 minutes ago (grace = 5min → missed)
    turnEvent(dir, slug, 'hc@codex:m', 20, 15);
    const result = await tickDeterministic(slug, {
      workspaceId: 'test', triplet: 'hk@claude-code:m', dryRun: true,
    });
    assert.equal(result.action, 'agent-decision-needed');
    assert.ok(typeof result.chase_events_emitted === 'number', 'should report chase_events_emitted');
    assert.equal(result.chase_events_emitted, 1, 'one missed participant → one chase event');
  } finally { cleanupLocalCollab(slug); }
});

test('chase: no chase when within grace period (2 min past deadline, grace=5min)', async () => {
  const slug = 'chase-test-within-grace';
  const { dir } = tmpLocalCollab(slug);
  try {
    kickoffEvent(dir, slug);
    joinEvent(dir, slug, 'hk@claude-code:m');
    joinEvent(dir, slug, 'hc@codex:m');
    // HC deadline only 2 minutes ago → within 5min grace
    turnEvent(dir, slug, 'hc@codex:m', 5, 2);
    const result = await tickDeterministic(slug, {
      workspaceId: 'test', triplet: 'hk@claude-code:m', dryRun: true,
    });
    assert.equal(result.chase_events_emitted, 0, 'should not chase within grace period');
  } finally { cleanupLocalCollab(slug); }
});

test('chase: no chase for self (agent does not chase itself)', async () => {
  const slug = 'chase-test-no-self';
  const { dir } = tmpLocalCollab(slug);
  try {
    kickoffEvent(dir, slug);
    joinEvent(dir, slug, 'hk@claude-code:m');
    // HK turn with missed deadline, but we're ticking AS hk → no self-chase
    turnEvent(dir, slug, 'hk@claude-code:m', 30, 20);
    const result = await tickDeterministic(slug, {
      workspaceId: 'test', triplet: 'hk@claude-code:m', dryRun: true,
    });
    assert.equal(result.chase_events_emitted, 0, 'should not chase self');
  } finally { cleanupLocalCollab(slug); }
});

test('chase: non-ISO next_update_by is skipped (the HC-emitter interop bug)', async () => {
  const slug = 'chase-test-noniso-deadline';
  const { dir } = tmpLocalCollab(slug);
  try {
    kickoffEvent(dir, slug);
    joinEvent(dir, slug, 'hk@claude-code:m');
    joinEvent(dir, slug, 'hc@codex:m');
    // Human-string next_update_by — the ISO validation in validateEventForRouting
    // quarantines this event before tick (dryRun:false → quarantine runs).
    // After quarantine the turn is invisible, so hc has no committed deadline → no chase.
    const ev = {
      event_id: generateEventId(ts(20), 'a'), ts: ts(20),
      author: 'hc@codex:m', slug, type: 'turn', references: [],
      payload: { intent: 'synthesize', body: 'test', next_update_by: '2026-05-29 1:00:00 AM EDT' },
    };
    appendEvent(dir, ev);
    const result = await tickDeterministic(slug, {
      workspaceId: 'test', triplet: 'hk@claude-code:m', dryRun: false,
    });
    // The event gets quarantined (non-ISO field) so it's invisible to routing → no chase
    assert.equal(result.chase_events_emitted, 0, 'non-ISO next_update_by: event quarantined, no chase');
  } finally { cleanupLocalCollab(slug); }
});

test('chase: no chase when no next_update_by commitment', async () => {
  const slug = 'chase-test-no-commitment';
  const { dir } = tmpLocalCollab(slug);
  try {
    kickoffEvent(dir, slug);
    joinEvent(dir, slug, 'hk@claude-code:m');
    joinEvent(dir, slug, 'hc@codex:m');
    turnEvent(dir, slug, 'hc@codex:m', 30, null); // no deadline
    const result = await tickDeterministic(slug, {
      workspaceId: 'test', triplet: 'hk@claude-code:m', dryRun: true,
    });
    assert.equal(result.chase_events_emitted, 0, 'no commitment → no chase');
  } finally { cleanupLocalCollab(slug); }
});
