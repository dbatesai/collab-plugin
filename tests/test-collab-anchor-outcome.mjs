/**
 * test-collab-anchor-outcome.mjs — the localhost order log and the deterministic outcome.
 *
 * Covers the handoff acceptance matrix rows that live in collab: anchored order and the
 * terminal prefix (2, 9), late events (10), tamper refusal (3), crash-repair and the
 * no-steal lock (4), and concurrent appenders including same-event retries (4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, linkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = mkdtempSync(join(tmpdir(), 'collab-anchor-'));
process.env.COLLAB_LOCAL_ROOT = join(ROOT, 'local');
process.env.COLLAB_STATE_ROOT = join(ROOT, 'state');

const { kickoff } = await import('../skills/collab/scripts/collab-kickoff.mjs');
const { appendEvent } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
const { tickDeterministic } = await import('../skills/collab/scripts/collab-tick.mjs');
const { computeOutcome } = await import('../skills/collab/scripts/collab-outcome.mjs');
const { readSlots, ORDER_DIR } = await import('../skills/collab/scripts/collab-anchor.mjs');

const R1 = 'core-codex@codex:host';
const WORKER = new URL('./fixtures/anchor-worker.mjs', import.meta.url).pathname;
let n = 0;

/** kickoff → R1 joins → proposer proposes close → R1 ratifies the measure → tick closes. */
async function closedRound(tag) {
  const k = await kickoff(`anchor round ${tag} ${++n}`, {
    workspaceId: 'anchor-test', transport: 'localhost', capabilitiesWanted: ['review'],
    measures: [{ id: 'M-1', description: 'the fixture converges', requires_review_from: R1 }],
  });
  const at = (min) => new Date(Date.now() - (30 - min) * 60000).toISOString();
  const ev = (author, type, min, payload, refs = []) => {
    const e = { event_id: `evt-${tag}-${type}-${min}`, ts: at(min), author, slug: k.slug, type, references: refs, payload };
    appendEvent(k.dir, e);
    return e;
  };
  ev(R1, 'join', 1, { capability_match: [], commitment: 'review', owes_review: ['M-1'] }, [k.kickoffEvt.event_id]);
  const pc = ev(k.triplet, 'propose-close', 2, { synthesis: 's', igm_met: {} });
  ev(R1, 'ratify', 3, { measures: ['M-1'] }, [pc.event_id]);
  const r = await tickDeterministic(k.slug, { workspaceId: 'anchor-test', triplet: k.triplet, dryRun: false });
  assert.equal(r.action, 'close', `round ${tag} closed`);
  return { k, ev };
}

const run = (args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  c.stdout.on('data', d => { out += d; }); c.stderr.on('data', d => { err += d; });
  c.on('close', code => resolve({ code, out, err }));
});

test('localhost kickoff creates the order log and every event gets one contiguous slot', async () => {
  const { k } = await closedRound('contig');
  const { slots, bad } = readSlots(k.dir);
  assert.deepEqual(bad, []);
  assert.deepEqual(slots.map(s => s.seq), slots.map((_, i) => i + 1));
  const ids = readdirSync(join(k.dir, 'events')).filter(f => f.endsWith('.json')).length;
  assert.equal(slots.length, ids, 'one slot per event file');
});

test('a closed collab has a deterministic outcome: same bytes on every read, bound to its prefix', async () => {
  const { k } = await closedRound('determ');
  const a = computeOutcome(k.dir, { participant: R1 });
  const b = computeOutcome(k.dir, { participant: R1 });
  assert.equal(a.status, 'closed');
  assert.equal(a.joined, true);
  assert.equal(a.outcome_bytes, b.outcome_bytes);
  const o = JSON.parse(a.outcome_bytes);
  assert.equal(o.close.payload.outcome, 'converged');
  assert.deepEqual(o.credited['M-1'].ratified.length, 1);
  assert.equal(o.prefix[o.prefix.length - 1].event_id, o.close.event_id);
  assert.equal(a.origin_anchor, `localhost:${o.prefix.length}`);
});

test('an event anchored after the close is late — even with an earlier timestamp — and the outcome bytes do not change', async () => {
  const { k } = await closedRound('late');
  const before = computeOutcome(k.dir);
  // A writer that read before the close and resumes after it, with a clock that says it was first.
  appendEvent(k.dir, { event_id: 'evt-late-verdict', ts: new Date(Date.now() - 3600_000).toISOString(), author: R1, slug: k.slug, type: 'note', references: [], payload: {} });
  const after = computeOutcome(k.dir);
  assert.equal(after.outcome_bytes, before.outcome_bytes);
  assert.deepEqual(after.late, ['evt-late-verdict']);
});

test('a changed or deleted anchored event refuses the outcome by name', async () => {
  const { k } = await closedRound('tamper');
  const { slots } = readSlots(k.dir);
  const target = join(k.dir, 'events', `${slots[1].event_id}.json`);
  const orig = readFileSync(target);
  writeFileSync(target, Buffer.concat([orig, Buffer.from(' ')]));   // one byte appended
  let r = computeOutcome(k.dir);
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.refusals, [`ledger-mutated ${slots[1].event_id}`]);
  rmSync(target);
  r = computeOutcome(k.dir);
  assert.deepEqual(r.refusals, [`orphan-slot ${slots[1].seq}`]);
});

test('a held order lock is refused, never stolen; the event stays unanchored until the next append repairs it once', async () => {
  const { k, ev } = await closedRound('lock');
  const lock = join(k.dir, ORDER_DIR, '.lock');
  mkdirSync(lock);                                   // another writer holds it
  const res = appendEvent(k.dir, { event_id: 'evt-lock-a', ts: new Date().toISOString(), author: R1, slug: k.slug, type: 'note', references: [], payload: {} });
  assert.match(res.anchor_error, /refused:order-lock-held/);
  assert.deepEqual(computeOutcome(k.dir).unanchored, ['evt-lock-a']);
  rmdirSync(lock);                                   // the holder finishes
  appendEvent(k.dir, { event_id: 'evt-lock-b', ts: new Date().toISOString(), author: R1, slug: k.slug, type: 'note', references: [], payload: {} });
  const r = computeOutcome(k.dir);
  assert.deepEqual(r.unanchored, []);
  const named = readSlots(k.dir).slots.map(s => s.event_id);
  assert.equal(named.filter(id => id === 'evt-lock-a').length, 1, 'anchored exactly once');
  assert.deepEqual(r.late, ['evt-lock-a', 'evt-lock-b'], 'both after the close');
});

test('a crash between the event write and its slot is repaired by the next append, with no gap', async () => {
  const { k } = await closedRound('crash');
  // The event file lands (temp + link, exactly as appendEvent does) but the process dies before anchoring.
  const e = { event_id: 'evt-crash-1', ts: new Date().toISOString(), author: R1, slug: k.slug, type: 'note', references: [], payload: {} };
  const tmp = join(k.dir, 'events', '.tmp-crash');
  writeFileSync(tmp, JSON.stringify(e, null, 2)); linkSync(tmp, join(k.dir, 'events', `${e.event_id}.json`)); rmSync(tmp);
  assert.deepEqual(computeOutcome(k.dir).unanchored, ['evt-crash-1']);
  appendEvent(k.dir, e);                             // the retry: identical bytes → idempotent, and anchors
  const { slots } = readSlots(k.dir);
  assert.deepEqual(slots.map(s => s.seq), slots.map((_, i) => i + 1));
  assert.equal(slots.filter(s => s.event_id === 'evt-crash-1').length, 1);
});

test('same-event simultaneous retries converge on one slot with no gap', async () => {
  const { k } = await closedRound('same');
  const e = { event_id: 'evt-same-1', ts: new Date().toISOString(), author: R1, slug: k.slug, type: 'note', references: [], payload: { v: 1 } };
  const start = join(ROOT, `start-same-${n}`);
  const workers = Array.from({ length: 8 }, () => run([k.dir, start, 'one', JSON.stringify(e)]));
  writeFileSync(start, '');
  const results = await Promise.all(workers);
  for (const r of results) assert.equal(r.code, 0, r.err);
  const { slots } = readSlots(k.dir);
  assert.equal(slots.filter(s => s.event_id === 'evt-same-1').length, 1, 'exactly one slot names it');
  assert.deepEqual(slots.map(s => s.seq), slots.map((_, i) => i + 1), 'no gap');
  assert.deepEqual(computeOutcome(k.dir).duplicate_slots, []);
});

test('distinct concurrent appenders get unique contiguous slots, and a concurrent reader never sees a malformed event', async () => {
  const k = await kickoff(`anchor concurrent ${++n}`, { workspaceId: 'anchor-test', transport: 'localhost' });
  const start = join(ROOT, `start-many-${n}`);
  const workers = Array.from({ length: 4 }, () => run([k.dir, start, 'many', '25']));
  const warnings = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s, ...a) => { if (/malformed|unreadable/.test(String(s))) warnings.push(String(s)); return realWrite(s, ...a); };
  const { readEvents } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  writeFileSync(start, '');
  let done = false;
  const all = Promise.all(workers).then(r => { done = true; return r; });
  while (!done) { readEvents(k.dir); await new Promise(r => setImmediate(r)); }
  process.stderr.write = realWrite;
  const results = await all;
  for (const r of results) assert.equal(r.code, 0, r.err);
  assert.deepEqual(warnings, [], 'the real reader never saw a half-written event');
  const { slots } = readSlots(k.dir);
  assert.equal(slots.length, 2 + 4 * 25);
  assert.deepEqual(slots.map(s => s.seq), slots.map((_, i) => i + 1));
  assert.equal(new Set(slots.map(s => s.event_id)).size, slots.length);
});

test('a damaged slot file holding the next number is skipped, never overwritten, and stays a named refusal', async () => {
  const k = await kickoff(`anchor badslot ${++n}`, { workspaceId: 'anchor-test', transport: 'localhost' });
  const next = readSlots(k.dir).slots.length + 1;
  writeFileSync(join(k.dir, ORDER_DIR, `${next}.json`), 'not json');
  appendEvent(k.dir, { event_id: 'evt-after-bad', ts: new Date().toISOString(), author: R1, slug: k.slug, type: 'note', references: [], payload: {} });
  const r = computeOutcome(k.dir);
  assert.deepEqual(r.refusals, [`bad-slot ${next}`]);
  assert.equal(readSlots(k.dir).slots.find(s => s.event_id === 'evt-after-bad').seq, next + 1);
});

test('a removed slot file in the middle of the log is a named slot-gap refusal', async () => {
  const { k } = await closedRound('gap');
  rmSync(join(k.dir, ORDER_DIR, '3.json'));
  const r = computeOutcome(k.dir);
  assert.equal(r.status, 'refused');
  assert.ok(r.refusals.includes('slot-gap 3'), r.refusals.join(';'));
});

test('cleanup', () => { rmSync(ROOT, { recursive: true, force: true }); });
