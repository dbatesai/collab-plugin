/**
 * test-collab-repo-lock.mjs — DG3 failure class 24.
 *
 * Concurrent same-worktree git operations must not corrupt shared refs or stop receipt.
 *
 * Live reproduction (D7): three same-machine sessions share one github:files working copy.
 * `.git/FETCH_HEAD` is shared mutable state, and a concurrent fetch leaves it holding
 * multiple branch entries, so `git pull --rebase` refuses outright:
 *   fatal: Cannot rebase onto multiple branches
 * Transient — retries succeed — but a client that treats a pull failure as fatal goes deaf
 * and reports a quiet channel, which is indistinguishable from "no peer activity".
 *
 * The ratified fix serializes repo operations behind a no-clobber claim with a lease, using
 * the same link() primitive as the event store, plus bounded jitter retry.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireRepoClaim, releaseRepoClaim, withRepoClaim, REPO_CLAIM_TTL_MS,
} from '../skills/collab/scripts/collab-event-helpers.mjs';

function mkRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-repolock-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

test('24: a second claimant on the same repo is refused while the first holds it', () => {
  const repo = mkRepo();
  try {
    const a = acquireRepoClaim(repo, 'owner-A');
    assert.ok(a, 'first claimant did not acquire');
    const b = acquireRepoClaim(repo, 'owner-B');
    assert.equal(b, null, 'two owners held the repo claim at once — operations are not serialized');
    releaseRepoClaim(repo, a);
    const c = acquireRepoClaim(repo, 'owner-B');
    assert.ok(c, 'claim was not released — the repo is now wedged');
    releaseRepoClaim(repo, c);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('24: the claim is released even when the guarded operation throws', () => {
  const repo = mkRepo();
  try {
    assert.throws(() => withRepoClaim(repo, 'owner-A', () => { throw new Error('boom'); }), /boom/);
    // A lock leaked on the error path is the failure mode the serialization fix could
    // introduce — a wedge worse than the race it prevents.
    const after = acquireRepoClaim(repo, 'owner-B');
    assert.ok(after, 'claim leaked after the guarded operation threw — repo permanently wedged');
    releaseRepoClaim(repo, after);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('24: an expired lease is reclaimable, so a dead owner cannot wedge the repo forever', () => {
  const repo = mkRepo();
  try {
    const a = acquireRepoClaim(repo, 'owner-A');
    assert.ok(a);

    // Simulate the owner dying: age the claim past its lease.
    const claimPath = join(repo, '.git', 'collab-repo-claim.json');
    assert.ok(existsSync(claimPath), 'claim artifact not at the expected path');
    const old = (Date.now() - REPO_CLAIM_TTL_MS - 60_000) / 1000;
    utimesSync(claimPath, old, old);

    const b = acquireRepoClaim(repo, 'owner-B');
    assert.ok(b, 'an expired lease was not reclaimable — a crashed process wedges the repo');
    // Generation must advance so a resurrected owner's late release cannot free someone
    // else's claim.
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
    assert.ok(claim.generation > a.generation, 'generation did not advance on reclaim');
    assert.equal(claim.owner, 'owner-B');
    releaseRepoClaim(repo, b);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('24: a stale owner cannot release a claim it no longer holds', () => {
  const repo = mkRepo();
  try {
    const a = acquireRepoClaim(repo, 'owner-A');
    const claimPath = join(repo, '.git', 'collab-repo-claim.json');
    const old = (Date.now() - REPO_CLAIM_TTL_MS - 60_000) / 1000;
    utimesSync(claimPath, old, old);
    const b = acquireRepoClaim(repo, 'owner-B');   // reclaims, generation++

    // The original owner wakes up and tries to release. It must not free B's claim.
    releaseRepoClaim(repo, a);
    assert.ok(
      existsSync(claimPath),
      'a stale owner released the current holder\'s claim — two writers can now proceed',
    );
    releaseRepoClaim(repo, b);
    assert.ok(!existsSync(claimPath), 'current holder could not release its own claim');
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('24: withRepoClaim returns the operation result and serializes nested attempts', () => {
  const repo = mkRepo();
  try {
    const order = [];
    const result = withRepoClaim(repo, 'owner-A', () => {
      // While held, another owner must not get in.
      assert.equal(acquireRepoClaim(repo, 'owner-B'), null, 'claim did not exclude a second owner mid-operation');
      order.push('ran');
      return 42;
    });
    assert.equal(result, 42, 'withRepoClaim did not return the operation result');
    assert.deepEqual(order, ['ran']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
