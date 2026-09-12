/**
 * test-collab-git-delivery.mjs — a timeout record on a git transport is delivered (R3-H3).
 *
 * A local file is not remote delivery. On a `github:<repo>` transport the tick must commit
 * and push everything it wrote — chases, wait-cycle notices, and timeout-action records
 * alike — and a record left behind by an interrupted tick must be published by the next
 * one without executing anything twice and without unrelated commits.
 *
 * Real git, real bare remote, all under a temp root: COLLAB_REPOS_ROOT points the transport
 * at a throwaway clone that tracks the bare remote.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE = mkdtempSync(join(tmpdir(), 'collab-git-delivery-'));
process.env.COLLAB_REPOS_ROOT = join(BASE, 'projects');
process.env.COLLAB_STATE_ROOT = join(BASE, 'state');
mkdirSync(process.env.COLLAB_REPOS_ROOT, { recursive: true });

// Roots are read at import time in places, so import after the env is set.
const { appendEvent, readEvents } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
const { tickDeterministic } = await import('../skills/collab/scripts/collab-tick.mjs');

const ME = 'core-framework@claude-code:host';
const R1 = 'core-codex@codex:host';
const REPO = 'files-test';
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

/** A clone tracking a bare remote, with one collab channel on the `github:files-test` transport. */
function mkGitChannel(slug, T0) {
  const remote = join(BASE, `${slug}-remote.git`);
  const repo = join(process.env.COLLAB_REPOS_ROOT, REPO);
  rmSync(remote, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  git(BASE, 'init', '--bare', '-b', 'main', remote);
  git(BASE, 'init', '-b', 'main', repo);
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, 'README.md'), 'test repo\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  const dir = join(repo, 'collabs', `2026-09-11-${slug}`);
  mkdirSync(join(dir, 'events'), { recursive: true });
  let n = 0;
  const add = (author, type, min, payload, references = []) => {
    const e = { event_id: `evt-${String(++n).padStart(3, '0')}`, ts: iso(T0 + min * MIN), author, slug, type, references, payload };
    appendEvent(dir, e);
    return e;
  };
  const ko = add(ME, 'kickoff', 0, { message: 'm', transport: `github:${REPO}`, igm: { intention: 'i', goal: 'g', measure: 'x' }, capabilities_wanted: ['review'], wall_clock_hours: 24, tick_interval_minutes: 5,
    ratified_completion_measures: [{ id: 'M-A', description: 'adapter A conforms', requires_review_from: R1 }] });
  add(ME, 'join', 0, { capability_match: [], commitment: 'own' }, [ko.event_id]);
  add(R1, 'join', 1, { capability_match: [], commitment: 'review', owes_review: ['M-A'] }, [ko.event_id]);
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'channel');
  git(repo, 'push', '-q');
  const remoteFiles = () => git(BASE, '--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  const remoteCommits = () => Number(git(BASE, '--git-dir', remote, 'rev-list', '--count', 'main'));
  const dirty = () => git(repo, 'status', '--porcelain', '--', dir);
  return { dir, repo, add, remoteFiles, remoteCommits, dirty };
}

const tick = (slug) => tickDeterministic(slug, { workspaceId: 'test', triplet: ME, dryRun: false });

test('git/delivery: a timeout-only tick commits and pushes the record; the next tick publishes nothing new', async () => {
  const slug = 'git-delivery-timeout';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'turn', 5, { intent: 'probe', body: 'please review M-A', signals: [], state: 'blocked', owner: R1, waiting_on: R1 });   // ME's bound: T0+10
  ch.git = git; git(ch.repo, 'add', '.'); git(ch.repo, 'commit', '-q', '-m', 'request'); git(ch.repo, 'push', '-q');
  const before = ch.remoteCommits();

  const r = await tick(slug);
  assert.equal(r.timeout_actions_executed, 1);
  assert.equal(r.chase_events_emitted, 0);
  const ta = readEvents(ch.dir).find(e => e.type === 'timeout-action');
  assert.ok(ta, 'no timeout record');
  assert.equal(ch.dirty(), '', `the timeout record was left uncommitted:\n${ch.dirty()}`);
  assert.ok(ch.remoteFiles().some(f => f.endsWith(`events/${ta.event_id}.json`)), 'the timeout record never reached the remote');
  assert.equal(ch.remoteCommits(), before + 1);

  const again = await tick(slug);
  assert.equal(again.timeout_actions_executed, 0);
  assert.equal(readEvents(ch.dir).filter(e => e.type === 'timeout-action').length, 1);
  assert.equal(ch.remoteCommits(), before + 1, 'a tick with nothing to publish made a commit');
});

test('git/delivery: a record left behind by an interrupted tick is published by the next tick, once, with no second execution', async () => {
  const slug = 'git-delivery-retry';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'turn', 5, { intent: 'probe', body: 'please review M-A', signals: [], state: 'blocked', owner: R1, waiting_on: R1 });
  git(ch.repo, 'add', '.'); git(ch.repo, 'commit', '-q', '-m', 'request'); git(ch.repo, 'push', '-q');
  const before = ch.remoteCommits();

  // The previous tick appended its timeout record and died before commit/push.
  const orphan = { event_id: 'evt-timeout-orphan', ts: iso(T0 + 11 * MIN), author: ME, slug, type: 'timeout-action', references: [],
    payload: { schema_version: '1.0', provenance: { emit_mode: 'automated', harness: 'obligation-scanner' }, action: 'proceed-alone', participant: ME, for_deadline: iso(T0 + 10 * MIN), chases_so_far: 0, signals: ['timeout-executed', 'proceed-alone'] } };
  writeFileSync(join(ch.dir, 'events', `${orphan.event_id}.json`), JSON.stringify(orphan, null, 2));
  assert.notEqual(ch.dirty(), '', 'test setup: the orphan should be unpublished');

  const r = await tick(slug);
  assert.equal(r.timeout_actions_executed, 0, 'the settled deadline executed again');
  assert.equal(readEvents(ch.dir).filter(e => e.type === 'timeout-action').length, 1);
  assert.equal(ch.dirty(), '', 'the orphaned record is still unpublished');
  assert.ok(ch.remoteFiles().some(f => f.endsWith('events/evt-timeout-orphan.json')));
  assert.equal(ch.remoteCommits(), before + 1);
  // Only the channel's own files travelled: nothing outside collabs/ was touched.
  const changed = git(ch.repo, 'diff', '--name-only', 'HEAD~1', 'HEAD').split('\n');
  assert.ok(changed.every(f => f.startsWith('collabs/')), `unrelated files in the publish commit: ${changed.join(', ')}`);
});

test.after(() => rmSync(BASE, { recursive: true, force: true }));
