/**
 * test-collab-quarantine-routed.mjs — DG3 failure class 23.
 *
 * Quarantine must be ROUTED, not merely preserved.
 *
 * Live reproduction (D6): a peer's DG1 ACCEPT — a decision, not chatter — failed v1
 * validation for a missing `provenance` block and was quarantined. The content was
 * preserved on disk as `.quarantined-<id>.json`, but nothing routed was emitted, so the
 * vote was invisible to every participant. All three of us reported "that peer is silent"
 * while a valid ACCEPT sat readable in the events directory. It surfaced only because one
 * peer happened to look in the directory by hand.
 *
 * Preserving bytes is necessary and not sufficient: if the only path from "quarantined" to
 * "anyone knows" runs through a human noticing, the mechanism is silent by default.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { quarantineInvalidV1Events } from '../skills/collab/scripts/collab-v1-quarantine.mjs';
import { readEvents, appendEvent } from '../skills/collab/scripts/collab-event-helpers.mjs';

const SLUG = 'quarantine-routed-channel';
const ME = 'core-framework@claude-code:host';
const PEER = 'core-gemini@gemini:host';

function mkChannel() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-qroute-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, {
    event_id: 'evt-kick', ts: '2026-07-30T04:00:00.000Z', author: ME, slug: SLUG,
    type: 'kickoff', references: [], payload: { message: 'fixture', pin: '313131' },
  });
  return dir;
}

/** A v1-declaring turn that carries a real decision but omits `provenance`. */
function invalidVoteEvent() {
  return {
    event_id: 'evt-peer-vote-0001', ts: '2026-07-30T04:11:00.000Z', author: PEER, slug: SLUG,
    type: 'turn', references: [],
    payload: {
      schema_version: '1.0', intent: 'critique',
      state: 'verifying', owner: ME, waiting_on: 'implementation',
      body: 'I explicitly ACCEPT the design.', signals: [],
      // provenance deliberately absent — this is the exact live failure
    },
  };
}

test('23: quarantining emits a ROUTED quarantined event naming id, author, and reason', () => {
  const dir = mkChannel();
  try {
    const bad = invalidVoteEvent();
    writeFileSync(join(dir, 'events', `${bad.event_id}.json`), JSON.stringify(bad, null, 2));

    const report = quarantineInvalidV1Events(dir, { author: ME });
    assert.equal(report.quarantined.length, 1, 'the invalid v1 event was not quarantined');

    // A2 — discoverable through a normal receive cycle, with NO directory inspection.
    const events = readEvents(dir);
    const notices = events.filter(e => e.type === 'quarantined');
    assert.equal(
      notices.length, 1,
      'no routed `quarantined` event was emitted — the suppression is invisible to peers, ' +
      'which is how a valid ACCEPT nearly went unseen',
    );

    const n = notices[0];
    assert.equal(n.payload.quarantined_event_id, bad.event_id, 'notice does not name the offending event id');
    assert.equal(n.payload.quarantined_author, PEER, 'notice does not name the offending event author');
    assert.match(String(n.payload.reason), /provenance/, `notice does not carry the exact validation failure: ${n.payload.reason}`);
    assert.ok(n.references.includes(bad.event_id), 'notice does not reference the quarantined event');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('23: quarantined content stays readable — a mechanical rejection never suppresses substance', () => {
  const dir = mkChannel();
  try {
    const bad = invalidVoteEvent();
    writeFileSync(join(dir, 'events', `${bad.event_id}.json`), JSON.stringify(bad, null, 2));
    quarantineInvalidV1Events(dir, { author: ME });

    const qFile = readdirSync(join(dir, 'events')).find(f => f.startsWith('.quarantined-'));
    assert.ok(qFile, 'quarantine artifact missing');
    const preserved = JSON.parse(readFileSync(join(dir, 'events', qFile), 'utf8'));
    assert.equal(
      preserved.payload.body, 'I explicitly ACCEPT the design.',
      'quarantined content was altered or lost — substance must survive a mechanical rejection',
    );
    assert.match(String(preserved._quarantine.reason), /provenance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('23: repeated scans do not emit duplicate quarantined notices', () => {
  const dir = mkChannel();
  try {
    const bad = invalidVoteEvent();
    writeFileSync(join(dir, 'events', `${bad.event_id}.json`), JSON.stringify(bad, null, 2));
    quarantineInvalidV1Events(dir, { author: ME });
    // The tick runs every cycle; a notice per cycle would flood the ledger.
    quarantineInvalidV1Events(dir, { author: ME });
    quarantineInvalidV1Events(dir, { author: ME });

    const notices = readEvents(dir).filter(e => e.type === 'quarantined');
    assert.equal(notices.length, 1, `quarantined notice emitted ${notices.length} times — floods the ledger`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('23: a valid v1 event produces no quarantine and no notice', () => {
  const dir = mkChannel();
  try {
    const good = invalidVoteEvent();
    good.event_id = 'evt-peer-vote-0002';
    good.payload.provenance = { emit_mode: 'automated', harness: 'gemini' };
    good.payload.next_update_by = '2026-07-30T05:30:00Z';
    writeFileSync(join(dir, 'events', `${good.event_id}.json`), JSON.stringify(good, null, 2));

    const report = quarantineInvalidV1Events(dir, { author: ME });
    assert.equal(report.quarantined.length, 0, 'a valid v1 event was quarantined');
    assert.equal(
      readEvents(dir).filter(e => e.type === 'quarantined').length, 0,
      'emitted a quarantine notice for a valid event — false alarms train peers to ignore notices',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
