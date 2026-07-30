/**
 * test-collab-append-noclobber.mjs — DG3 failure classes 5, 8, 9.
 *
 * 5: two writers holding the same event_id with DIFFERENT content — exactly one file
 *    survives with one writer's bytes intact, and the loser is TOLD.
 * 8: same event_id with byte-IDENTICAL content — idempotent success, not an error.
 * 9: a torn/partial write is never visible as an event.
 *
 * Why this matters more than it looks: `temp + rename` is atomic but NOT exclusive.
 * POSIX rename() silently replaces an existing destination. So the pre-fix appendEvent
 * would take D4's "recorded conflict" case and turn it straight back into a silent
 * overwrite — the exact data loss the globally-unique-id work was meant to end. The
 * ratified fix is link(temp, final), which fails EEXIST, then unlink the temp.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvent, readEvents } from '../skills/collab/scripts/collab-event-helpers.mjs';

function mkCollabDir() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-noclobber-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  return dir;
}

const ID = 'evt-202607300400-shared-1a2b3c4d-1111-2222-3333-444455556666';
const base = (v) => ({
  event_id: ID, ts: '2026-07-30T04:00:00.000Z', author: `writer-${v}@h:i`,
  slug: 's', type: 'turn', references: [], payload: { intent: 'propose', body: `content-${v}`, signals: [] },
});

test('5: same event_id + different content — one survives intact, loser is told, no blend', () => {
  const dir = mkCollabDir();
  try {
    const first = base('A');
    const second = base('B');

    appendEvent(dir, first);

    // The loser must be told. A refused write that reports success is precisely the
    // silent overwrite this class exists to prevent.
    let told = false;
    try {
      appendEvent(dir, second);
    } catch (e) {
      told = true;
      assert.match(
        String(e.message), /conflict/i,
        `conflict error should name the condition, got: ${e.message}`,
      );
    }
    assert.ok(told, 'second writer of a conflicting same-id event was NOT told — silent overwrite');

    // Exactly one event file, and its bytes are ONE writer's, never a merge.
    const files = readdirSync(join(dir, 'events')).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    assert.equal(files.length, 1, `expected exactly 1 event file, got ${files.length}`);

    const onDisk = readFileSync(join(dir, 'events', files[0]), 'utf8');
    const isA = onDisk === JSON.stringify(first, null, 2);
    const isB = onDisk === JSON.stringify(second, null, 2);
    assert.ok(isA || isB, 'surviving file is neither writer\'s bytes — content was blended');
    // First writer wins under link() semantics: the name already existed.
    assert.ok(isA, 'the already-committed event was replaced — rename overwrote instead of refusing');

    const events = readEvents(dir);
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.body, 'content-A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('8: same event_id + byte-identical content is idempotent success, not an error', () => {
  const dir = mkCollabDir();
  try {
    const ev = base('A');
    appendEvent(dir, ev);
    // A retry-safe path that errors on retry breaks recovery — the recovery ladder
    // re-appends after a transport failure and must not treat that as a conflict.
    assert.doesNotThrow(() => appendEvent(dir, ev), 'identical re-append should be idempotent success');

    const files = readdirSync(join(dir, 'events')).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    assert.equal(files.length, 1, 'identical re-append created a duplicate file');
    assert.equal(readEvents(dir).length, 1, 'duplicate event visible to a receive cycle');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('5: no temp stragglers left behind after a refused conflicting write', () => {
  const dir = mkCollabDir();
  try {
    appendEvent(dir, base('A'));
    try { appendEvent(dir, base('B')); } catch { /* expected */ }
    const tmps = readdirSync(join(dir, 'events')).filter(f => f.startsWith('.tmp-'));
    assert.equal(tmps.length, 0, `refused write leaked ${tmps.length} temp file(s) — repeated conflicts would fill the store`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9: a torn partial write is never delivered as an event, and a clean append still works', () => {
  const dir = mkCollabDir();
  try {
    // Simulate a process killed after the temp landed but before finalization.
    const orphan = join(dir, 'events', `.tmp-${ID}-9999-1234-abcd.json`);
    writeFileSync(orphan, '{"event_id":"evt-torn","ts":"2026-07-30T04:00:00.000Z"');  // truncated JSON

    const before = readEvents(dir);
    assert.equal(before.length, 0, 'a partial temp file was delivered as an event');

    // The reader must be healthy, not merely quiet: a clean append still lands and reads.
    appendEvent(dir, base('A'));
    const after = readEvents(dir);
    assert.equal(after.length, 1, 'reader did not recover after encountering a partial file');
    assert.equal(after[0].payload.body, 'content-A');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
