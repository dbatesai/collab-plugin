/**
 * test-collab-legacy-surface-survival.mjs — DG3 failure classes 22, 14, 16.
 *
 * 22: a legacy JSONL-only writer's events must survive another participant's render.
 * 14: legacy migration is AUTOMATIC — no operator step — validated, and emits a
 *     `reconciled` event naming exactly what was imported.
 * 16: a foreign event that is invalid or belongs to another channel must NOT auto-import;
 *     it escalates, and valid events beside it still import.
 *
 * Live reproduction (D5): Agy's harness runs a legacy v0.1.x writer that appends only to
 * events.jsonl. Keel and Hale ran `render`, which rebuilds events.jsonl FROM events/.
 * Agy's turn — a Semantic Concede on the central design question — was destroyed. No error
 * was raised on either side; Agy discovered it by noticing their own turn was gone.
 *
 * This is a DATA-LOSS test, so assertions are on surviving bytes, never on absence of
 * errors.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent, readEvents, renderEventsJsonl, reconcileForeignSurface,
} from '../skills/collab/scripts/collab-event-helpers.mjs';

const SLUG = 'legacy-survival-channel';
const B = 'core-framework@claude-code:host';   // modern writer (events/)
const A = 'core-gemini@gemini:host';           // legacy writer (events.jsonl only)

const ev = (id, author, body, slug = SLUG) => ({
  event_id: id, ts: '2026-07-30T04:00:00.000Z', author, slug,
  type: 'turn', references: [],
  payload: { intent: 'propose', body, signals: [] },
});

/** Channel where B wrote via events/, and A appended a line only to events.jsonl. */
function mkMixedChannel({ legacyEvents }) {
  const dir = mkdtempSync(join(tmpdir(), 'collab-legacy-'));
  mkdirSync(join(dir, 'events'), { recursive: true });

  const bJoin = { ...ev('evt-b-join', B, 'join'), type: 'join' };
  // A joined the channel and then wrote through a legacy JSONL-only writer. Membership is
  // what authorizes the import (§7 predicate 4); the legacy surface is just how it wrote.
  const aJoin = { ...ev('evt-a-join', A, 'join'), type: 'join' };
  const b1 = ev('evt-b-0001', B, 'modern-1');
  appendEvent(dir, bJoin);
  appendEvent(dir, aJoin);
  appendEvent(dir, b1);

  // A's legacy writer appends to events.jsonl: it rewrites the whole file from what it
  // can see, then adds its own line. Its own event exists ONLY here.
  const lines = [bJoin, aJoin, b1, ...legacyEvents].map(e => JSON.stringify(e));
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n');
  return dir;
}

test('22: a legacy JSONL-only event survives reconcile and lands in canonical', () => {
  const aTurn = ev('evt-a-legacy-0001', A, 'semantic-concede-on-sse');
  const dir = mkMixedChannel({ legacyEvents: [aTurn] });
  try {
    const before = readEvents(dir).map(e => e.event_id);
    assert.ok(!before.includes('evt-a-legacy-0001'), 'fixture invalid: legacy event already canonical');

    const r = reconcileForeignSurface(dir, B);

    assert.deepEqual(r.imported, ['evt-a-legacy-0001'], `expected the legacy event imported, got ${JSON.stringify(r.imported)}`);

    // Data-loss assertion: the bytes must be in canonical, with content intact.
    const files = readdirSync(join(dir, 'events')).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    assert.ok(files.includes('evt-a-legacy-0001.json'), 'legacy event not written to canonical store');
    const after = readEvents(dir);
    const found = after.find(e => e.event_id === 'evt-a-legacy-0001');
    assert.ok(found, 'legacy event not visible to a receive cycle after reconcile');
    assert.equal(found.payload.body, 'semantic-concede-on-sse', 'legacy event content was altered');
    assert.equal(found.author, A, 'legacy event authorship was rewritten');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('14: reconcile is automatic and emits a `reconciled` event naming exactly what it imported', () => {
  const aTurn = ev('evt-a-legacy-0002', A, 'legacy-two');
  const dir = mkMixedChannel({ legacyEvents: [aTurn] });
  try {
    reconcileForeignSurface(dir, B);
    const events = readEvents(dir);
    const rec = events.filter(e => e.type === 'reconciled');
    assert.equal(rec.length, 1, `expected exactly one reconciled event, got ${rec.length}`);
    assert.deepEqual(
      rec[0].payload.imported, ['evt-a-legacy-0002'],
      'reconciled event does not name the imported ids — a silent heal is indistinguishable from a bug',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('22: renderEventsJsonl REFUSES to overwrite unreconciled foreign events (the D5 guard)', () => {
  const aTurn = ev('evt-a-legacy-0003', A, 'would-be-destroyed');
  const dir = mkMixedChannel({ legacyEvents: [aTurn] });
  try {
    // Pre-fix, this call silently destroyed A's line. The guard must live at the writer
    // boundary so any caller — hook, script, future protocol path — inherits it.
    assert.throws(
      () => renderEventsJsonl(dir),
      /unreconciled|foreign/i,
      'render did not refuse: a legacy writer\'s event is about to be destroyed with no error',
    );

    // And the bytes are still there — refusing must not itself lose anything.
    const jsonl = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    assert.ok(jsonl.includes('evt-a-legacy-0003'), 'refused render still damaged events.jsonl');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('22: after reconcile, render proceeds and preserves the imported event', () => {
  const aTurn = ev('evt-a-legacy-0004', A, 'survives-render');
  const dir = mkMixedChannel({ legacyEvents: [aTurn] });
  try {
    reconcileForeignSurface(dir, B);
    renderEventsJsonl(dir);   // must now succeed
    const jsonl = readFileSync(join(dir, 'events.jsonl'), 'utf8');
    assert.ok(jsonl.includes('evt-a-legacy-0004'), 'imported legacy event missing from rendered events.jsonl');
    assert.ok(jsonl.includes('survives-render'), 'imported legacy event content missing after render');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('16: a foreign event for a DIFFERENT channel does not auto-import, and valid ones beside it still do', () => {
  const wrongChannel = ev('evt-a-wrong-0001', A, 'other-channel', 'some-other-slug');
  const valid = ev('evt-a-legacy-0005', A, 'valid-beside-invalid');
  const dir = mkMixedChannel({ legacyEvents: [wrongChannel, valid] });
  try {
    const r = reconcileForeignSurface(dir, B);

    assert.ok(!r.imported.includes('evt-a-wrong-0001'), 'imported an event belonging to another channel');
    assert.ok(
      r.escalated.some(x => x.event_id === 'evt-a-wrong-0001'),
      'channel mismatch was neither imported nor escalated — it vanished silently',
    );
    // One bad event must not halt all healing.
    assert.ok(r.imported.includes('evt-a-legacy-0005'), 'a valid event beside a rejected one failed to import');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('16: a malformed foreign line escalates rather than crashing or vanishing', () => {
  const valid = ev('evt-a-legacy-0006', A, 'valid-beside-malformed');
  const dir = mkMixedChannel({ legacyEvents: [valid] });
  try {
    // Append a truncated line, as a killed legacy writer would leave behind.
    const p = join(dir, 'events.jsonl');
    writeFileSync(p, readFileSync(p, 'utf8') + '{"event_id":"evt-torn","ts":\n');

    const r = reconcileForeignSurface(dir, B);
    assert.ok(r.imported.includes('evt-a-legacy-0006'), 'valid event did not import alongside a malformed line');
    assert.ok(
      r.escalated.length >= 1,
      'malformed line was neither imported nor escalated — silently dropped',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('15: a second reconcile does not re-import or duplicate the reconciled receipt', () => {
  const aTurn = ev('evt-a-legacy-0007', A, 'idempotent-reconcile');
  const dir = mkMixedChannel({ legacyEvents: [aTurn] });
  try {
    reconcileForeignSurface(dir, B);
    const r2 = reconcileForeignSurface(dir, B);
    assert.deepEqual(r2.imported, [], 'second reconcile re-imported an already-imported event');
    const rec = readEvents(dir).filter(e => e.type === 'reconciled');
    assert.equal(rec.length, 1, `reconciled receipt duplicated: ${rec.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
