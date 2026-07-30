/**
 * test-collab-event-id-entropy.mjs — DG3 failure classes 4 and 21.
 *
 * D4: two participants emitting the same event_id merge, and readEvents dedups
 *     "first wins" — a peer's turn vanishes with no error. The ratified design requires
 *     globally unique ids; sequential ids are migration-only.
 *
 * The case that actually matters (Hale): `participant_id` is PERSISTED, so two concurrent
 * processes — or one process after a restart — reuse the same participant component. A
 * 32-bit random field then carries the whole collision burden, and a per-process counter
 * provides no protection across processes because each starts its own sequence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPERS = join(HERE, '../skills/collab/scripts/collab-event-helpers.mjs');

const { generateEventId } = await import(HELPERS);

// A UUID v4 as produced by crypto.randomUUID(): 8-4-4-4-12 hex with dashes.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test('4: 10k ids from one participant in one process are all unique', () => {
  const ts = '2026-07-30T04:00:00.000Z';
  const ids = new Set();
  for (let i = 0; i < 10_000; i++) ids.add(generateEventId(ts, 'core-framework'));
  assert.equal(ids.size, 10_000, 'in-process id collision');
});

test('4: ids from two different participants never collide', () => {
  const ts = '2026-07-30T04:00:00.000Z';
  const ids = new Set();
  for (let i = 0; i < 5_000; i++) {
    ids.add(generateEventId(ts, 'core-framework'));
    ids.add(generateEventId(ts, 'core-codex'));
  }
  assert.equal(ids.size, 10_000, 'cross-participant id collision');
});

/**
 * A3 — the assertion that deterministically kills the pre-fix generator.
 *
 * Cross-process collision cannot be caught reliably by a probabilistic test: with 32 bits
 * of randomness a few thousand ids collide only rarely, so such a test would pass on most
 * runs and be flaky rather than protective. So this asserts the STRUCTURE the ratified
 * design requires — a UUID-grade random component — which fails pre-fix every time.
 *
 * Pre-fix suffix: 8 hex chars + 2 base36 counter chars. Post-fix: a full UUIDv4.
 */
test('4: the random component is UUID-grade, not a short per-process nonce', () => {
  const id = generateEventId('2026-07-30T04:00:00.000Z', 'core-framework');
  assert.match(
    id, UUID_RE,
    `event id lacks a UUID-grade random component (a short nonce plus a per-process counter ` +
    `collides across processes sharing one persisted participant_id): ${id}`,
  );
});

test('4: ids remain unique across separate PROCESSES sharing one participant_id', () => {
  const ts = '2026-07-30T04:00:00.000Z';
  const PER_PROC = 2_000;
  const PROCS = 4;
  const script = `
    const { generateEventId } = await import(${JSON.stringify(HELPERS)});
    const out = [];
    for (let i = 0; i < ${PER_PROC}; i++) out.push(generateEventId(${JSON.stringify(ts)}, 'shared-participant'));
    process.stdout.write(out.join('\\n'));
  `;
  const all = new Set();
  let produced = 0;
  for (let p = 0; p < PROCS; p++) {
    const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const ids = stdout.trim().split('\n').filter(Boolean);
    produced += ids.length;
    for (const id of ids) all.add(id);
  }
  assert.equal(produced, PER_PROC * PROCS, 'child processes did not produce the expected id count');
  assert.equal(
    all.size, produced,
    `${produced - all.size} id(s) collided across processes sharing one participant_id — ` +
    `each process restarts its own counter, so a per-process sequence cannot prevent this`,
  );
});

test('4: the generator does not depend on existing store state', () => {
  // A generator that reads the store (sequential max+1) produces duplicates whenever two
  // writers observe the same store. generateEventId must be a pure function of its args.
  assert.equal(generateEventId.length, 2, 'generateEventId should take only (tsIso, authorSlug)');
  const a = generateEventId('2026-07-30T04:00:00.000Z', 'p');
  const b = generateEventId('2026-07-30T04:00:00.000Z', 'p');
  assert.notEqual(a, b, 'two calls with identical args must still differ');
});

/**
 * Live emitters must not use the sequential helper. `nextEventId` is retained for
 * migration only (its own tests still assert evt-001 semantics), but any code path that
 * emits a NEW event into a multi-writer channel must use generateEventId — otherwise two
 * agents independently compute the same evt-NNN and readEvents silently drops one.
 *
 * Source-level assertion because the defect is "which function got called", and reaching
 * it through the tick path would require simulating two concurrent live channels.
 */
test('4: collab-tick emits with generateEventId, never the sequential helper', () => {
  const src = readFileSync(join(HERE, '../skills/collab/scripts/collab-tick.mjs'), 'utf8');
  const seqCalls = src.match(/nextEventId\s*\(/g) || [];
  assert.equal(
    seqCalls.length, 0,
    `collab-tick still emits ${seqCalls.length} event(s) with sequential nextEventId — ` +
    `two agents ticking concurrently compute the same id and one event is silently dropped`,
  );
  assert.ok(/generateEventId\s*\(/.test(src), 'collab-tick should emit via generateEventId');
});
