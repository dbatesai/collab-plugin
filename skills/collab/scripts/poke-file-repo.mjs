#!/usr/bin/env node
// Rung-2 poke adapter for the file-repo (git) transport — see references/collaboration-ladder.md.
// Notify-only: reports whether the canonical stream's head moved since the last verified head.
// Carries no content and no authority; never reads entries, never writes the stream, never
// starts a daemon. Cost rule: one fetch, then exit — nothing here wakes a model.
import { execFileSync } from 'node:child_process';
import * as fsMod from 'node:fs';
import * as osMod from 'node:os';
import * as pathMod from 'node:path';
import assertMod from 'node:assert/strict';

export const ROUTE = 'file-repo';

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 }).trim();
}

// state: { lastVerifiedHead: string|null }. remote/ref name the canonical stream.
export function check(state, { repoDir, remote = 'origin', ref = 'main', now = () => new Date().toISOString() } = {}) {
  const observedAt = now();
  let head;
  try {
    const out = git(['ls-remote', '--exit-code', remote, `refs/heads/${ref}`], repoDir);
    head = out.split(/\s+/)[0] || null;
  } catch (e) {
    const reason = e && e.status === 2 ? 'ref-absent' : 'unreachable';
    return { landed: false, head: null, observedAt, route: ROUTE, reason };
  }
  if (!head) return { landed: false, head: null, observedAt, route: ROUTE, reason: 'ref-absent' };
  const last = state && state.lastVerifiedHead ? String(state.lastVerifiedHead) : null;
  return { landed: head !== last, head, observedAt, route: ROUTE };
}

export function selfCheck() {
  const { mkdtempSync, rmSync, writeFileSync } = fsMod; const { tmpdir } = osMod; const { join } = pathMod; const assert = assertMod;
  const base = mkdtempSync(join(tmpdir(), 'poke-file-repo-'));
  try {
    const bare = join(base, 'stream.git'), work = join(base, 'work'), peer = join(base, 'peer');
    git(['init', '-q', '--bare', '-b', 'main', bare], base);
    git(['clone', '-q', bare, work], base);
    git(['-c', 'user.name=fixture', '-c', 'user.email=f@x', 'commit', '-q', '--allow-empty', '-m', 'genesis'], work);
    git(['push', '-q', 'origin', 'main'], work);
    git(['clone', '-q', bare, peer], base);
    const genesis = git(['rev-parse', 'HEAD'], peer);
    // Never-verified peer: the first observation lands, and it is the genesis head.
    let r = check({ lastVerifiedHead: null }, { repoDir: peer });
    assert.equal(r.landed, true); assert.equal(r.head, genesis); assert.equal(r.route, ROUTE);
    // Quiet stream: same head → nothing landed, one fetch, exit.
    r = check({ lastVerifiedHead: genesis }, { repoDir: peer });
    assert.equal(r.landed, false); assert.equal(r.head, genesis); assert.equal(r.reason, undefined);
    // A peer pushes: the head moves, the poke says so — and says nothing about what landed.
    writeFileSync(join(work, 'entry.txt'), 'x');
    git(['add', 'entry.txt'], work);
    git(['-c', 'user.name=fixture', '-c', 'user.email=f@x', 'commit', '-q', '-m', 'entry'], work);
    git(['push', '-q', 'origin', 'main'], work);
    const next = git(['rev-parse', 'HEAD'], work);
    r = check({ lastVerifiedHead: genesis }, { repoDir: peer });
    assert.equal(r.landed, true); assert.equal(r.head, next);
    assert.ok(!('content' in r) && !('entries' in r), 'a poke carries no content');
    // Counter-control: verifying the new head silences the next check.
    r = check({ lastVerifiedHead: next }, { repoDir: peer });
    assert.equal(r.landed, false);
    // Unreachable stream: landed false with a reason, never a throw, never a stale "landed".
    rmSync(bare, { recursive: true, force: true });
    r = check({ lastVerifiedHead: genesis }, { repoDir: peer });
    assert.equal(r.landed, false); assert.equal(r.head, null); assert.ok(['unreachable', 'ref-absent'].includes(r.reason));
    process.stdout.write('poke-file-repo self-check: PASS (6 checks; notify-only, one fetch per check, unreachable is a reason not a landing)\n');
    return 0;
  } finally { rmSync(base, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.includes('--self-check')) process.exit(selfCheck());
  const repoDir = args.find(a => !a.startsWith('--')) || process.cwd();
  const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
  const r = check({ lastVerifiedHead: opt('last') || null }, { repoDir, remote: opt('remote') || 'origin', ref: opt('ref') || 'main' });
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(0);
}
