import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isV1Event, validateEventForRouting, quarantineEvent, quarantineInvalidV1Events,
} from '../skills/collab/scripts/collab-v1-quarantine.mjs';
import { readEvents } from '../skills/collab/scripts/collab-event-helpers.mjs';

function v1Turn(overrides = {}) {
  return {
    event_id: 'evt-202605290500-a-1234',
    ts: '2026-05-29T05:00:00.000Z',
    author: 'a@claude-code:m', slug: 's', type: 'turn',
    payload: {
      schema_version: '1.0',
      intent: 'synthesize', body: 'something substantive here',
      state: 'working', owner: 'b@codex:m', waiting_on: null,
      next_update_by: '2026-05-29T05:30:00.000Z',
      provenance: { emit_mode: 'interactive', harness: 'claude-code' },
      ...overrides.payload,
    },
    ...overrides.top,
  };
}

function v02Turn(overrides = {}) {
  return {
    event_id: 'evt-202605290400-a-0001',
    ts: '2026-05-29T04:00:00.000Z',
    author: 'a@claude-code:m', slug: 's', type: 'turn',
    payload: { intent: 'synthesize', body: 'legacy event', signals: [], ...overrides },
  };
}

// --- isV1Event ---

test('isV1Event: true when schema_version major >= 1', () => {
  assert.equal(isV1Event(v1Turn()), true);
});

test('isV1Event: false for legacy v0.2 (no schema_version)', () => {
  assert.equal(isV1Event(v02Turn()), false);
});

test('isV1Event: false for schema_version 0.x', () => {
  assert.equal(isV1Event(v1Turn({ payload: { schema_version: '0.9' } })), false);
});

// --- validateEventForRouting ---

test('validateEventForRouting: valid v1 turn passes', () => {
  const v = validateEventForRouting(v1Turn());
  assert.equal(v.tier, 'v1');
  assert.equal(v.valid, true);
  assert.equal(v.reason, null);
});

test('validateEventForRouting: legacy event always valid (warn-only is caller concern)', () => {
  const v = validateEventForRouting(v02Turn());
  assert.equal(v.tier, 'legacy');
  assert.equal(v.valid, true);
});

test('validateEventForRouting: v1 missing provenance → invalid', () => {
  const e = v1Turn(); delete e.payload.provenance;
  const v = validateEventForRouting(e);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'missing-provenance');
});

test('validateEventForRouting: v1 missing owner → invalid', () => {
  const e = v1Turn(); delete e.payload.owner;
  const v = validateEventForRouting(e);
  assert.equal(v.valid, false);
  assert.match(v.reason, /missing-field:owner/);
});

test('validateEventForRouting: v1 invalid state → invalid', () => {
  const v = validateEventForRouting(v1Turn({ payload: { state: 'bogus' } }));
  assert.equal(v.valid, false);
  assert.match(v.reason, /invalid-state:bogus/);
});

test('validateEventForRouting: v1 next_update_by human string → invalid (the session-52 interop bug)', () => {
  const v = validateEventForRouting(v1Turn({ payload: { next_update_by: '2026-05-29 1:00:00 AM EDT' } }));
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'next_update_by-not-iso8601');
});

test('validateEventForRouting: v1 next_update_by ISO passes', () => {
  const v = validateEventForRouting(v1Turn({ payload: { next_update_by: '2026-05-29T05:30:00Z' } }));
  assert.equal(v.valid, true);
});

test('validateEventForRouting: v1 empty next_update_by allowed (no deadline)', () => {
  const v = validateEventForRouting(v1Turn({ payload: { next_update_by: '' } }));
  assert.equal(v.valid, true);
});

// --- quarantineEvent + readEvents integration ---

function tmpCollab() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-q-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  return dir;
}

function writeEvt(dir, event) {
  writeFileSync(join(dir, 'events', `${event.event_id}.json`), JSON.stringify(event));
}

test('quarantineEvent: writes .quarantined- artifact and removes original from routing', () => {
  const dir = tmpCollab();
  try {
    const e = v1Turn(); delete e.payload.provenance;
    writeEvt(dir, e);
    quarantineEvent(dir, e, 'missing-provenance');
    const files = readdirSync(join(dir, 'events'));
    assert.ok(files.some(f => f === `.quarantined-${e.event_id}.json`), 'quarantine artifact exists');
    // Original evt-<id>.json should no longer be a routable file
    assert.ok(!files.includes(`${e.event_id}.json`), 'original removed from routing namespace');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('readEvents: skips quarantined dotfiles (the gap found session 52)', () => {
  const dir = tmpCollab();
  try {
    const good = v02Turn();
    const bad = v1Turn(); delete bad.payload.provenance;
    writeEvt(dir, good);
    writeEvt(dir, bad);
    quarantineInvalidV1Events(dir);
    const routed = readEvents(dir);
    const ids = routed.map(e => e.event_id);
    assert.ok(ids.includes(good.event_id), 'valid legacy event still routes');
    assert.ok(!ids.includes(bad.event_id), 'quarantined v1 event does NOT route');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quarantineInvalidV1Events: quarantines v1-invalid, warns (not quarantines) legacy', () => {
  const dir = tmpCollab();
  try {
    const v1bad = v1Turn({ payload: { next_update_by: 'human string' } });
    writeEvt(dir, v1bad);
    const report = quarantineInvalidV1Events(dir);
    assert.equal(report.quarantined.length, 1);
    assert.equal(report.quarantined[0].reason, 'next_update_by-not-iso8601');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('quarantineInvalidV1Events: valid v1 + legacy events left untouched', () => {
  const dir = tmpCollab();
  try {
    writeEvt(dir, v1Turn());
    writeEvt(dir, v02Turn());
    const report = quarantineInvalidV1Events(dir);
    assert.equal(report.quarantined.length, 0);
    assert.equal(readEvents(dir).length, 2, 'both events still route');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
