/**
 * test-collab-recovery-election.mjs — DG3 failure class 13.
 *
 * Simultaneous recovery attempts must not elect two writers.
 *
 * Why append-immutability is not enough: `link(temp, final)` makes an *event* safe, because
 * an event file is written once and never again. Recovery is not that. Recovery mutates
 * reconciliation and retirement state — which surface is authoritative, which foreign surface
 * has been drained, which receipt describes the heal. Two agents can both hold a valid
 * append-only store and still both believe they own the repair. Append-immutability elects
 * nobody.
 *
 * Ownership therefore comes from two things, and the tests below separate them because a
 * test that conflates them can pass with either one missing:
 *   1. a DETERMINISTIC recovery operation key, so both participants contend for the same
 *      lock rather than each taking a private one; and
 *   2. a single ATOMIC no-clobber claim artifact carrying `owner`, `lease_expires` and
 *      `generation`, so exactly one contender wins, a dead owner cannot wedge the lane
 *      forever, and a resurrected owner cannot mutate state it no longer owns.
 *
 * Concurrency here is real: separate OS processes, released from a rendezvous barrier, not
 * a sleep. A `setTimeout`-shaped concurrency test passes on a fast machine and proves
 * nothing, which is the exact failure mode this suite exists to prevent.
 *
 * NAMING NOTE: the ratified design specifies the mechanism, not its function names. This
 * test binds it to `recoveryOperationKey` / `acquireRecoveryClaim` / `releaseRecoveryClaim`
 * / `RECOVERY_CLAIM_TTL_MS` / `recoverForeignSurface`, matching the existing
 * `acquireRepoClaim` family. An implementation that names them differently should rename
 * here, not weaken the assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync,
  existsSync, utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

/**
 * Locate the helpers by walking up to the repo root rather than hard-coding `../` depth.
 * This file is red against shipped code by design, so it lives under `tests/pending/` until
 * class 13 is implemented and then moves to `tests/`. A fixed relative path silently becomes
 * ERR_MODULE_NOT_FOUND on that move — still "red", but red for the wrong reason, which is the
 * exact failure the pending-test convention exists to prevent.
 */
const HELPERS = (() => {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const p = join(d, 'skills', 'collab', 'scripts', 'collab-event-helpers.mjs');
    if (existsSync(p)) return p;
    d = dirname(d);
  }
  throw new Error('could not locate skills/collab/scripts/collab-event-helpers.mjs above ' + import.meta.url);
})();

const helpers = await import(pathToFileURL(HELPERS).href);
const { appendEvent, readEvents } = helpers;

const SLUG = 'recovery-election-channel';
const LEGACY = 'core-gemini@gemini:host';           // wrote only to events.jsonl — the broken lane
const B = 'core-framework@claude-code:host';        // recoverer 1
const C = 'core-second@claude-code:host';           // recoverer 2
const D = 'core-third@claude-code:host';            // arrives after the lease expires

const ev = (id, author, body, type = 'turn') => ({
  event_id: id, ts: '2026-07-30T04:00:00.000Z', author, slug: SLUG, type,
  references: [], payload: { intent: 'propose', body, signals: [] },
});

/**
 * A channel whose canonical store is intact but whose events.jsonl holds one event canonical
 * does not have. Every joined participant detects the same broken lane on its next cycle, so
 * every one of them will try to repair it. That is the setup, verbatim: "two participants
 * both detect the same broken lane."
 */
function mkBrokenLane() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-recovery-election-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  const joins = [
    ev('evt-legacy-join', LEGACY, 'join', 'join'),
    ev('evt-b-join', B, 'join', 'join'),
    ev('evt-c-join', C, 'join', 'join'),
    ev('evt-d-join', D, 'join', 'join'),
  ];
  for (const j of joins) appendEvent(dir, j);
  const orphan = ev('evt-legacy-orphan', LEGACY, 'the-turn-only-the-broken-lane-holds');
  writeFileSync(
    join(dir, 'events.jsonl'),
    [...joins, orphan].map(e => JSON.stringify(e)).join('\n') + '\n',
  );
  return dir;
}

// --- Real-process concurrency harness -------------------------------------------------
//
// A rendezvous barrier, not a delay. Each worker announces itself and then blocks until every
// peer has announced, so the contended call happens while all of them are inside it. The
// deadline exists so a barrier that can never complete fails loudly instead of hanging the
// suite until the runner's timeout, which would read as an infrastructure problem rather than
// a defect.
const BARRIER = `
import { writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
function rendezvous(root, gate, me, n) {
  const d = join(root, gate);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, me), '');
  const deadline = Date.now() + 8000;
  while (readdirSync(d).length < n) {
    if (Date.now() > deadline) {
      // Naming who arrived is the difference between "the harness is slow" and "a peer died
      // in the call under test" — the second is a finding, the first is noise.
      throw new Error('barrier ' + gate + ' never filled: arrived [' + readdirSync(d).sort().join(',') + '] of ' + n);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
  }
}
`;

function writeWorker(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, `${BARRIER}\nimport * as H from ${JSON.stringify(HELPERS)};\n${body}\n`);
  return p;
}

/** Run workers as genuinely separate OS processes and collect their reported outcomes. */
function runConcurrently(worker, argvs) {
  return Promise.all(argvs.map(argv => new Promise((resolve) => {
    const p = spawn(process.execPath, [worker, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out); } catch { /* reported below with stderr attached */ }
      resolve(parsed ?? { crashed: true, code, stderr: err.trim(), stdout: out.trim() });
    });
  })));
}

function assertNoCrash(results) {
  const crashed = results.filter(r => r.crashed);
  assert.equal(
    crashed.length, 0,
    'a recovery worker could not run at all. The class-13 mechanism (deterministic operation ' +
    'key + atomic claim) must be exported from collab-event-helpers.mjs. First failure:\n' +
    (crashed[0] ? crashed[0].stderr || `exit ${crashed[0].code}` : ''),
  );
}

// --- 1. Both contenders must compute the SAME operation key ---------------------------

test('13: two participants recovering the same lane compute the same operation key', async () => {
  const dir = mkBrokenLane();
  try {
    const worker = writeWorker(dir, 'w-key.mjs', `
const [dir, me, gate, n] = process.argv.slice(2);
rendezvous(dir, gate, me, Number(n));
process.stdout.write(JSON.stringify({ me, key: H.recoveryOperationKey(dir, 'events.jsonl') }));
`);
    const results = await runConcurrently(worker, [
      [dir, B, 'gate-key', '2'],
      [dir, C, 'gate-key', '2'],
    ]);
    assertNoCrash(results);

    const keys = results.map(r => r.key);
    assert.ok(keys.every(k => typeof k === 'string' && k.length > 0), `operation key must be a non-empty string, got ${JSON.stringify(keys)}`);
    assert.equal(
      new Set(keys).size, 1,
      `the two contenders computed DIFFERENT operation keys (${JSON.stringify(keys)}) — each would ` +
      'take a private lock and both would proceed. The key must be a function of the lane, ' +
      'never of the participant computing it.',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('13: the operation key is per-lane, not one global constant', () => {
  const a = mkBrokenLane();
  const b = mkBrokenLane();
  try {
    // "Both compute the same key" is satisfied vacuously by returning a constant, which would
    // serialize every unrelated recovery on the machine behind one lock and turn a repair
    // queue into a stall. The key must discriminate.
    assert.notEqual(
      helpers.recoveryOperationKey(a, 'events.jsonl'),
      helpers.recoveryOperationKey(b, 'events.jsonl'),
      'two different channels produced the same recovery operation key — the key is a constant, ' +
      'so unrelated lanes contend for one claim',
    );
    assert.notEqual(
      helpers.recoveryOperationKey(a, 'events.jsonl'),
      helpers.recoveryOperationKey(a, 'quarantine'),
      'two different lanes in the same channel produced the same operation key',
    );
    // Deterministic across calls — a key with a nonce in it never contends with itself.
    assert.equal(
      helpers.recoveryOperationKey(a, 'events.jsonl'),
      helpers.recoveryOperationKey(a, 'events.jsonl'),
      'the operation key is not deterministic across calls',
    );
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

// --- 2. Exactly one writer, and the loser is RECORDED ---------------------------------

const RECOVER_WORKER = `
const [dir, me, gate, n] = process.argv.slice(2);
if (gate !== '-') rendezvous(dir, gate, me, Number(n));
let out;
try {
  const r = H.recoverForeignSurface(dir, me);
  out = { me, role: r.role, imported: r.imported ?? [], reason: r.reason ?? null };
} catch (e) {
  out = { me, threw: true, code: e.code ?? null, message: e.message };
}
process.stdout.write(JSON.stringify(out));
`;

test('13: a second participant arriving while the claim is held stands down, recorded', async () => {
  const dir = mkBrokenLane();
  try {
    // Deterministic contention, not a race won by luck: B's claim is already on disk and
    // still inside its lease when C starts. This is the branch that matters and it must not
    // depend on scheduling to be reached. It also proves the claim is a durable artifact
    // rather than in-process state — C is a separate OS process and can see nothing else.
    const key = helpers.recoveryOperationKey(dir, 'events.jsonl');
    const bClaim = helpers.acquireRecoveryClaim(dir, key, B);
    assert.ok(bClaim, 'B could not take the recovery claim');

    const worker = writeWorker(dir, 'w-standdown.mjs', RECOVER_WORKER);
    const [c] = await runConcurrently(worker, [[dir, C, '-', '1']]);
    assertNoCrash([c]);

    assert.equal(
      c.role, 'stood-down',
      `C did not stand down while B held a live claim — two writers are now in the same recovery. Got: ${JSON.stringify(c)}`,
    );
    // The loser must be TOLD which contention it lost. "I found nothing to do" and "someone
    // else owns this" are different states, and a recovery ladder that cannot tell them apart
    // either retries forever or gives up silently.
    assert.match(
      String(c.reason ?? ''), /claim|held|owner|exists/i,
      `the stand-down did not name the contention it lost, got: ${JSON.stringify(c.reason)}`,
    );

    const during = readEvents(dir);
    // A2, authorship inspected rather than corruption assumed absent: C must not have touched
    // reconciliation state at all. Standing down and *also* repairing is still two writers.
    assert.equal(
      during.filter(e => e.type === 'reconciled').length, 0,
      'the participant that stood down wrote a reconciliation receipt anyway',
    );
    assert.ok(
      !during.some(e => e.event_id === 'evt-legacy-orphan'),
      'the participant that stood down mutated the lane it had just been refused',
    );
    // The stand-down is durable in the record, not merely a return value a caller may drop.
    const sd = during.filter(e => e.type === 'stand-down');
    assert.equal(
      sd.length, 1,
      `expected exactly 1 recorded \`stand-down\` event, got ${sd.length} — an unrecorded ` +
      'stand-down leaves no evidence the second attempt was ever refused',
    );
    assert.equal(sd[0].author, C, 'the stand-down was attributed to the wrong participant');

    // A2, positively asserted: the lane still gets repaired. A claim that simply refused
    // everyone would satisfy "not two writers" while healing nothing — the fake-pass this
    // class is most exposed to.
    helpers.releaseRecoveryClaim(dir, bClaim);
    const done = helpers.recoverForeignSurface(dir, B);
    assert.equal(done.role, 'owner', 'the claim holder could not complete its own recovery after release');
    const after = readEvents(dir);
    const repaired = after.find(e => e.event_id === 'evt-legacy-orphan');
    assert.ok(repaired, 'the broken lane was never repaired');
    assert.equal(repaired.author, LEGACY, 'the recovered event\'s authorship was rewritten');
    assert.equal(repaired.payload.body, 'the-turn-only-the-broken-lane-holds', 'the recovered event\'s content was altered');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('13: two genuinely concurrent recoveries produce exactly one writer of the repair', async () => {
  const dir = mkBrokenLane();
  try {
    const worker = writeWorker(dir, 'w-recover.mjs', RECOVER_WORKER);
    const results = await runConcurrently(worker, [
      [dir, B, 'gate-recover', '2'],
      [dir, C, 'gate-recover', '2'],
    ]);
    assertNoCrash(results);

    const events = readEvents(dir);

    // The invariant is about WRITERS, not claimants. Whichever way the two processes
    // interleave — overlapping, or one completing before the other starts — exactly one of
    // them may have mutated reconciliation state. Asserting on the receipt rather than on the
    // return values is what keeps this true under every interleaving instead of the lucky one.
    const reconciled = events.filter(e => e.type === 'reconciled');
    assert.equal(
      reconciled.length, 1,
      `${reconciled.length} \`reconciled\` receipts for one repair — both participants wrote the ` +
      `reconciliation state. Authors: ${JSON.stringify(reconciled.map(e => e.author))}`,
    );
    assert.equal(
      new Set(reconciled.map(e => e.author)).size, 1,
      'the reconciliation record names more than one author',
    );

    const repairers = results.filter(r => (r.imported ?? []).length > 0);
    assert.equal(
      repairers.length, 1,
      `${repairers.length} participants reported importing the orphaned event — the repair was ` +
      `performed twice. Results: ${JSON.stringify(results)}`,
    );
    assert.equal(reconciled[0].author, repairers[0].me, 'the receipt names a participant that did not perform the repair');

    // A2, positive: the lane is actually healed, and healed once.
    const orphans = events.filter(e => e.event_id === 'evt-legacy-orphan');
    assert.equal(orphans.length, 1, 'the recovered event is duplicated in canonical');
    assert.equal(orphans[0].payload.body, 'the-turn-only-the-broken-lane-holds', 'the recovered event\'s content was altered');

    // Both processes must have reached a defined outcome. A crash or an undefined role would
    // let the two assertions above pass while nothing was actually contended.
    assert.ok(
      results.every(r => r.role === 'owner' || r.role === 'stood-down'),
      `a participant reached no defined recovery outcome: ${JSON.stringify(results)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. The claim itself must be atomic, proven under N-way contention ----------------

test('13: the recovery claim is exclusive under repeated N-way process contention', async () => {
  const dir = mkBrokenLane();
  const N = 8, ROUNDS = 25;
  try {
    // check-then-write is the natural wrong implementation and it survives a two-process,
    // one-shot test on a fast machine. Eight processes released together, 25 times, is what
    // makes the TOCTOU window impossible to miss: on the broken version every contender
    // passes the existence check before any of them writes.
    //
    // The THREE barriers per round are what make "one winner" a property of the lock rather
    // than of scheduling. With a single barrier the winner can release before a slow peer has
    // even attempted, and that peer then wins the same round legitimately — a second winner
    // that proves nothing was broken. Holding the claim until everyone has attempted removes
    // that reading entirely: in each round the claim is contended by all N at once.
    const worker = writeWorker(dir, 'w-claim.mjs', `
const [dir, me, n, rounds] = process.argv.slice(2);
const N = Number(n);
const wins = [], losses = [];
for (let r = 0; r < Number(rounds); r++) {
  const key = H.recoveryOperationKey(dir, 'lane-' + r);
  rendezvous(dir, 'gate-start-' + r, me, N);      // all contenders present
  const claim = H.acquireRecoveryClaim(dir, key, me);
  rendezvous(dir, 'gate-tried-' + r, me, N);      // nobody releases until all have attempted
  if (claim) { wins.push(r); H.releaseRecoveryClaim(dir, claim); } else { losses.push(r); }
  rendezvous(dir, 'gate-clear-' + r, me, N);      // round fully unwound before the next
}
process.stdout.write(JSON.stringify({ me, wins, losses }));
`);
    const ids = Array.from({ length: N }, (_, i) => `owner-${i}`);
    const results = await runConcurrently(worker, ids.map(id => [dir, id, String(N), String(ROUNDS)]));
    assertNoCrash(results);

    const winnersPerRound = new Map();
    for (const r of results) for (const round of r.wins) {
      if (!winnersPerRound.has(round)) winnersPerRound.set(round, []);
      winnersPerRound.get(round).push(r.me);
    }

    const doubled = [...winnersPerRound.entries()].filter(([, w]) => w.length > 1);
    assert.equal(
      doubled.length, 0,
      `${doubled.length} of ${ROUNDS} rounds elected MORE THAN ONE writer — the claim is not ` +
      `atomic. First: round ${doubled[0]?.[0]} won by ${JSON.stringify(doubled[0]?.[1])}`,
    );
    // The mirror assertion. A claim that always refuses is trivially "never two writers" and
    // is a total recovery outage, so every round must also have elected somebody.
    const starved = Array.from({ length: ROUNDS }, (_, i) => i).filter(i => !winnersPerRound.has(i));
    assert.equal(
      starved.length, 0,
      `${starved.length} of ${ROUNDS} rounds elected NO writer — the claim refuses everyone and ` +
      `recovery can never run. Rounds: ${JSON.stringify(starved.slice(0, 5))}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 4. Lease expiry, and the generation that goes with it ----------------------------

test('13: an expired lease is reclaimable by a third attempt, with an incremented generation', () => {
  const dir = mkBrokenLane();
  try {
    const key = helpers.recoveryOperationKey(dir, 'events.jsonl');
    const first = helpers.acquireRecoveryClaim(dir, key, B);
    assert.ok(first, 'the first contender did not acquire the recovery claim');

    assert.equal(
      helpers.acquireRecoveryClaim(dir, key, C), null,
      'a second contender acquired the claim while the first still holds a live lease',
    );

    // The owner dies mid-recovery. Age the artifact past its lease rather than waiting one
    // out: the assertion is about the reclaim rule, not about elapsed wall-clock.
    const claimPath = findClaimArtifact(dir, key);
    const aged = (Date.now() - helpers.RECOVERY_CLAIM_TTL_MS - 60_000) / 1000;
    utimesSync(claimPath, aged, aged);

    const third = helpers.acquireRecoveryClaim(dir, key, D);
    assert.ok(third, 'an expired lease was not reclaimable — a crashed recoverer wedges the lane forever');
    assert.ok(
      third.generation > first.generation,
      `generation did not advance on reclaim (${first.generation} -> ${third.generation}) — nothing ` +
      'distinguishes the new owner from the dead one',
    );
    const onDisk = JSON.parse(readFileSync(claimPath, 'utf8'));
    assert.equal(onDisk.owner, D, 'the claim artifact does not name the current owner');
    assert.ok(onDisk.lease_expires, 'the claim artifact carries no lease_expires — the lease is unreadable to anyone but its author');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 5. The resurrected owner ---------------------------------------------------------

test('13: a stale owner\'s late write is rejected on generation mismatch', () => {
  const dir = mkBrokenLane();
  try {
    const key = helpers.recoveryOperationKey(dir, 'events.jsonl');
    const stale = helpers.acquireRecoveryClaim(dir, key, B);
    assert.ok(stale);

    const claimPath = findClaimArtifact(dir, key);
    const aged = (Date.now() - helpers.RECOVERY_CLAIM_TTL_MS - 60_000) / 1000;
    utimesSync(claimPath, aged, aged);
    const current = helpers.acquireRecoveryClaim(dir, key, D);   // reclaims, generation++
    assert.ok(current, 'fixture invalid: the expired claim was not reclaimable');

    // B wakes up believing it still owns the repair. "Exactly one winner" is already true and
    // says nothing about this moment: the dangerous write happens AFTER the election, from a
    // process that was never told it lost.
    let refused = false;
    try {
      helpers.recoverForeignSurface(dir, B, { claim: stale });
    } catch (e) {
      refused = true;
      assert.match(
        String(e.message), /generation|stale|no longer|claim/i,
        `the refusal did not name the generation mismatch, got: ${e.message}`,
      );
    }
    assert.ok(refused, 'a stale owner mutated retirement state after losing the claim — two writers, one late');

    // And its release must not free the live owner's claim.
    helpers.releaseRecoveryClaim(dir, stale);
    assert.ok(
      existsSync(claimPath),
      'a stale owner released the current holder\'s claim — the lane is now open to a second writer',
    );
    const held = JSON.parse(readFileSync(claimPath, 'utf8'));
    assert.equal(held.owner, D, 'the stale owner overwrote the live claim');
    assert.equal(held.generation, current.generation, 'the stale owner rolled the generation back');

    // A2: inspect authorship of the mutable state, do not infer safety from lack of corruption.
    const receipts = readEvents(dir).filter(e => e.type === 'reconciled');
    assert.ok(
      receipts.every(e => e.author !== B),
      'the stale owner wrote a reconciliation receipt after losing the claim',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Locate the claim artifact for an operation key without pinning its exact filename. */
function findClaimArtifact(dir, key) {
  const roots = [dir, join(dir, '.recovery'), join(dir, 'events')];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root)) {
      if (!f.includes('claim')) continue;
      const p = join(root, f);
      try {
        const j = JSON.parse(readFileSync(p, 'utf8'));
        if (j && (j.operation_key === key || f.includes(key))) return p;
      } catch { /* not a claim artifact */ }
    }
  }
  assert.fail(
    `no recovery claim artifact found for operation key ${key} under ${dir} — the claim is not ` +
    'a durable on-disk artifact, so a second process has nothing to collide with',
  );
}
