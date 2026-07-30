/**
 * test-collab-watch-miss.mjs — DG3 failure class 10.
 *
 * 10: a missed `fs.watch` notification must not lose an event.
 *
 * fs.watch is documented to drop notifications — network volumes, load, rename storms,
 * platform differences. If receipt depends on the notification arriving, a peer's turn is
 * simply gone and the channel reads as quiet. That is the failure shape this whole
 * taxonomy exists to kill: no error, no event, everyone waiting. The periodic reconcile
 * is the backstop, and this file is what keeps fs.watch an optimization rather than the
 * delivery path.
 *
 * The miss is SIMULATED, never raced. The watcher here is a stand-in whose notifications
 * are generated and then dropped on purpose, so nothing depends on real OS watcher timing.
 * A flaky test on a data-loss class is worse than no test.
 *
 * Assertions are paired per the design:
 *   A1 — the event lost by the dropped notification is delivered by the reconcile pass.
 *   A2 — the delivery is attributed to the RECONCILE path while the watch path is proven
 *        empty. The final test proves the watch path is a live channel that CAN deliver,
 *        so its emptiness above is suppression rather than a prop that never fires.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent, readEvents, reconcileForeignSurface,
} from '../skills/collab/scripts/collab-event-helpers.mjs';

const SLUG = 'watch-miss-channel';
const SELF = 'core-framework@claude-code:host';   // the receiving participant
const PEER = 'core-codex@codex:host';             // the participant whose event goes unnoticed

const ev = (id, author, body, ts, type = 'turn') => ({
  event_id: id, ts, author, slug: SLUG, type, references: [],
  payload: { intent: 'propose', body, signals: [] },
});

/** A joined channel with three settled events, written the way a real participant writes. */
function mkChannel() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-watch-miss-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, ev('evt-kickoff', SELF, 'kickoff', '2026-07-30T04:00:00.000Z', 'kickoff'));
  appendEvent(dir, ev('evt-peer-join', PEER, 'join', '2026-07-30T04:01:00.000Z', 'join'));
  appendEvent(dir, ev('evt-self-0001', SELF, 'opening', '2026-07-30T04:02:00.000Z'));
  return dir;
}

/** The event ids actually committed to the canonical store, read straight off disk. */
function idsOnDisk(dir) {
  return readdirSync(join(dir, 'events'))
    .filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => f.slice(0, -'.json'.length))
    .sort();
}

/**
 * A participant with exactly two intake channels, so "which path delivered this" is a
 * fact the test can read rather than infer:
 *   - acceptFromWatch(id) — the notification path
 *   - reconcile()         — the periodic pass, a full re-derivation from disk
 * Every delivered id is stamped with the path that produced it.
 */
function makeReceiver(dir) {
  const delivered = new Map(); // event_id → 'watch' | 'reconcile'
  return {
    delivered,
    acceptFromWatch(eventId) {
      if (!delivered.has(eventId)) delivered.set(eventId, 'watch');
    },
    /** The periodic reconcile. Takes a directory and nothing else — no notification input. */
    reconcile() {
      const fresh = [];
      reconcileForeignSurface(dir, SELF);   // heal foreign surfaces, then re-derive
      for (const e of readEvents(dir)) {
        if (!delivered.has(e.event_id)) { delivered.set(e.event_id, 'reconcile'); fresh.push(e.event_id); }
      }
      return fresh;
    },
    idsFrom(path) {
      return [...delivered].filter(([, p]) => p === path).map(([id]) => id).sort();
    },
  };
}

/**
 * A registered, live watcher whose notifications are dropped before they reach the
 * receiver — the miss fs.watch permits. It records what it lost so the test proves the
 * miss happened instead of assuming it. Flipping `suppressed` off makes it deliver, which
 * is how the last test shows this channel is real.
 */
function suppressedWatch(receiver) {
  return {
    suppressed: true,
    dropped: [],
    /** The OS produced a notification for this id. Suppressed, it never arrives. */
    notify(eventId) {
      if (this.suppressed) { this.dropped.push(eventId); return false; }
      receiver.acceptFromWatch(eventId);
      return true;
    },
  };
}

test('10: an event whose watch notification was dropped is still delivered, by reconcile', () => {
  const dir = mkChannel();
  try {
    const rx = makeReceiver(dir);
    const watch = suppressedWatch(rx);

    rx.reconcile();                                     // settled: everything already on disk is known
    const LOST = 'evt-peer-0001';
    assert.ok(!rx.delivered.has(LOST), 'fixture invalid: the peer event was known before it was written');

    // The peer commits to disk. Nothing in-process is told; the notification is dropped.
    appendEvent(dir, ev(LOST, PEER, 'the-turn-nobody-was-told-about', '2026-07-30T04:10:00.000Z'));
    assert.equal(watch.notify(LOST), false, 'fixture invalid: the watch notification was not suppressed');
    assert.deepEqual(watch.dropped, [LOST], 'the miss under test did not actually occur');
    assert.deepEqual(rx.idsFrom('watch'), [], 'the watch path delivered something despite being suppressed');

    // A1 — the periodic reconcile delivers it.
    const fresh = rx.reconcile();
    assert.ok(
      fresh.includes(LOST),
      `reconcile did not deliver the event the dropped notification lost — it is gone with no error. fresh=${JSON.stringify(fresh)}`,
    );

    // A2 — delivery is attributed to reconcile, and the watch path is still empty.
    assert.equal(
      rx.delivered.get(LOST), 'reconcile',
      'the event was delivered by the watch path, so this proves nothing about watch being non-load-bearing',
    );
    assert.deepEqual(rx.idsFrom('watch'), [], 'the watch path delivered after the notification was dropped');
    assert.ok(rx.idsFrom('reconcile').includes(LOST), 'reconcile is not credited with the delivery it made');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10: EVERY event that lands during a suppressed window is delivered, not just the newest', () => {
  const dir = mkChannel();
  try {
    const rx = makeReceiver(dir);
    const watch = suppressedWatch(rx);
    rx.reconcile();

    const lost = ['evt-peer-0002', 'evt-peer-0003', 'evt-peer-0004'];
    lost.forEach((id, i) => {
      appendEvent(dir, ev(id, PEER, `burst-${i}`, `2026-07-30T04:2${i}:00.000Z`));
      watch.notify(id);
    });
    assert.deepEqual(watch.dropped, lost, 'fixture invalid: not every notification in the window was dropped');

    const fresh = rx.reconcile();
    // A high-water or last-notified reader delivers only the newest and calls itself caught up.
    for (const id of lost) {
      assert.ok(fresh.includes(id), `${id} was lost in the suppressed window — reconcile delivered ${JSON.stringify(fresh)}`);
      assert.equal(rx.delivered.get(id), 'reconcile', `${id} was not credited to the reconcile path`);
    }
    assert.deepEqual(rx.idsFrom('watch'), [], 'the watch path delivered during a fully suppressed window');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10: reconcile is a full re-derivation from disk, so a receiver with no watcher misses nothing', () => {
  const dir = mkChannel();
  try {
    appendEvent(dir, ev('evt-peer-0005', PEER, 'arrived-with-nobody-watching', '2026-07-30T04:30:00.000Z'));

    // No watcher was ever registered. If reconcile were a delta over notified paths, a cold
    // receiver would come up holding less than the store holds.
    const rx = makeReceiver(dir);
    const fresh = rx.reconcile();

    assert.deepEqual(
      fresh.sort(), idsOnDisk(dir),
      'one reconcile pass did not deliver the complete committed store — the pass is a delta, not a re-derivation',
    );
    assert.deepEqual(rx.idsFrom('watch'), [], 'a receiver with no watcher attributed a delivery to the watch path');
    assert.ok(fresh.length > 0, 'fixture invalid: nothing was on disk to deliver');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10: a peer event on a foreign surface during a suppressed window is recovered by reconcile', () => {
  const dir = mkChannel();
  try {
    const rx = makeReceiver(dir);
    const watch = suppressedWatch(rx);
    rx.reconcile();

    // A legacy JSONL-only peer writes where canonical cannot see it and no notification lands.
    const LOST = 'evt-peer-legacy-0001';
    const legacy = ev(LOST, PEER, 'legacy-surface-turn', '2026-07-30T04:40:00.000Z');
    const known = readEvents(dir).map(e => JSON.stringify(e));
    writeFileSync(join(dir, 'events.jsonl'), [...known, JSON.stringify(legacy)].join('\n') + '\n');
    watch.notify(LOST);
    assert.deepEqual(watch.dropped, [LOST], 'fixture invalid: the notification was not dropped');

    const fresh = rx.reconcile();
    assert.ok(fresh.includes(LOST), `the foreign-surface turn was not recovered by reconcile: fresh=${JSON.stringify(fresh)}`);
    assert.equal(rx.delivered.get(LOST), 'reconcile', 'the foreign-surface turn was not credited to the reconcile path');

    // The heal must leave a record; a silent import is indistinguishable from a bug.
    const receipts = readEvents(dir).filter(e => e.type === 'reconciled');
    assert.equal(receipts.length, 1, `expected one reconciled receipt, got ${receipts.length}`);
    assert.ok(receipts[0].payload.imported.includes(LOST), 'the reconciled receipt does not name the recovered event');
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'events', `${LOST}.json`), 'utf8')).payload.body,
      'legacy-surface-turn',
      'the recovered event bytes were altered on import',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10: reconcile delivers the recovered event exactly once', () => {
  const dir = mkChannel();
  try {
    const rx = makeReceiver(dir);
    const watch = suppressedWatch(rx);
    rx.reconcile();

    const LOST = 'evt-peer-0006';
    appendEvent(dir, ev(LOST, PEER, 'delivered-once', '2026-07-30T04:50:00.000Z'));
    watch.notify(LOST);

    assert.deepEqual(rx.reconcile(), [LOST], 'first reconcile did not deliver exactly the missed event');
    assert.deepEqual(rx.reconcile(), [], 're-delivered an already-delivered event: the backstop double-delivers');
    assert.deepEqual(rx.reconcile(), [], 're-delivered on the third pass');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('10 (fixture integrity): the watch path CAN deliver — its emptiness above is suppression', () => {
  const dir = mkChannel();
  try {
    const rx = makeReceiver(dir);
    const watch = suppressedWatch(rx);
    rx.reconcile();

    const SEEN = 'evt-peer-0007';
    appendEvent(dir, ev(SEEN, PEER, 'notification-arrived', '2026-07-30T04:55:00.000Z'));
    watch.suppressed = false;

    // Without this, every "the watch path delivered nothing" assertion above would hold
    // trivially for a channel incapable of delivering anything at all.
    assert.equal(watch.notify(SEEN), true, 'the watch stand-in cannot deliver even unsuppressed — the A2 assertions are vacuous');
    assert.deepEqual(rx.idsFrom('watch'), [SEEN], 'an unsuppressed notification was not attributed to the watch path');
    assert.deepEqual(watch.dropped, [], 'an unsuppressed notification was recorded as dropped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
