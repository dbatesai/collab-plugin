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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const BASE = mkdtempSync(join(tmpdir(), 'collab-git-delivery-'));
process.env.COLLAB_REPOS_ROOT = join(BASE, 'projects');
process.env.COLLAB_STATE_ROOT = join(BASE, 'state');
process.env.COLLAB_LOCAL_ROOT = join(BASE, 'local');            // the ownership manifest lives beside it, not in ~/.collab
mkdirSync(process.env.COLLAB_REPOS_ROOT, { recursive: true });

// Roots are read at import time in places, so import after the env is set.
const { appendEvent, readEvents, deliveryManifestPath, eventFilenameViolations } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
const { validateEvents } = await import('../skills/collab/scripts/collab-validate.mjs');
const { render } = await import('../skills/collab/scripts/collab-render.mjs');
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


// ------------------------------------------------------------ the two delivery boundaries (R3-H3 after-commit, R3-H4 ownership)

/** A timeout record the real emitter would have written, as a file (the interrupted-tick shape). */
function orphanRecord(ch, slug, T0, id = 'evt-timeout-orphan') {
  const rec = { event_id: id, ts: iso(T0 + 11 * MIN), author: ME, slug, type: 'timeout-action', references: [],
    payload: { schema_version: '1.0', provenance: { emit_mode: 'automated', harness: 'obligation-scanner' }, action: 'proceed-alone', participant: ME, for_deadline: iso(T0 + 10 * MIN), chases_so_far: 0, signals: ['timeout-executed', 'proceed-alone'] } };
  writeFileSync(join(ch.dir, 'events', `${id}.json`), JSON.stringify(rec, null, 2));
  return rec;
}
const request = (ch) => ch.add(ME, 'turn', 5, { intent: 'probe', body: 'please review M-A', signals: [], state: 'blocked', owner: R1, waiting_on: R1 });
const sync = (ch, msg = 'sync') => { git(ch.repo, 'add', '.'); git(ch.repo, 'commit', '-q', '-m', msg); git(ch.repo, 'push', '-q'); };
const upstreamMatchesHead = (ch) => git(ch.repo, 'rev-parse', 'HEAD') === git(ch.repo, 'rev-parse', '@{u}');

test('git/delivery: a record committed but not pushed by an interrupted tick is delivered by the next tick — a clean tree is not a delivery receipt (R3-H3)', async () => {
  const slug = 'git-delivery-after-commit';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  request(ch); sync(ch, 'request');
  const before = ch.remoteCommits();
  orphanRecord(ch, slug, T0);
  git(ch.repo, 'add', '.'); git(ch.repo, 'commit', '-q', '-m', 'tick: 1 timeout-action (push never happened)');
  assert.equal(ch.dirty(), '', 'test setup: the tree should be clean');
  assert.equal(ch.remoteCommits(), before, 'test setup: the remote should be behind');

  const r = await tick(slug);
  assert.equal(r.timeout_actions_executed, 0, 'the settled deadline executed again');
  assert.equal(readEvents(ch.dir).filter(e => e.type === 'timeout-action').length, 1);
  assert.ok(ch.remoteFiles().some(f => f.endsWith('events/evt-timeout-orphan.json')), 'the committed record never reached the remote');
  assert.equal(ch.remoteCommits(), before + 1, 'delivery must push the existing commit, not make another');
  assert.ok(upstreamMatchesHead(ch), 'delivery was not verified against the upstream ref');
  assert.equal(r.delivery.pushed, true);
  assert.equal(r.delivery.verified, true);
});

test('git/delivery: an unrelated draft and a foreign author\'s file under the channel are never published; an owned record beside them is (R3-H4)', async () => {
  const slug = 'git-delivery-ownership';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  request(ch); sync(ch, 'request');
  const before = ch.remoteCommits();
  writeFileSync(join(ch.dir, 'private-draft.txt'), 'not for anyone yet\n');
  mkdirSync(join(ch.dir, 'notes'), { recursive: true });
  writeFileSync(join(ch.dir, 'notes', 'scratch.md'), '# scratch\n');
  const foreign = { event_id: 'evt-foreign', ts: iso(T0 + 6 * MIN), author: R1, slug, type: 'turn', references: [],
    payload: { schema_version: '1.0', provenance: { emit_mode: 'interactive', harness: 'codex' }, intent: 'clarify', body: 'a peer\'s unpublished turn on this shared clone', signals: [], state: 'working', owner: R1, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) } };
  writeFileSync(join(ch.dir, 'events', 'evt-foreign.json'), JSON.stringify(foreign, null, 2));

  const r = await tick(slug);                       // ME's own bound is due → one owned record written this tick
  assert.equal(r.timeout_actions_executed, 1);
  const ta = readEvents(ch.dir).find(e => e.type === 'timeout-action');
  const remote = ch.remoteFiles();
  assert.ok(remote.some(f => f.endsWith(`events/${ta.event_id}.json`)), 'the owned record was not delivered');
  assert.ok(!remote.some(f => f.endsWith('private-draft.txt')), 'an unselected draft was published');
  assert.ok(!remote.some(f => f.endsWith('notes/scratch.md')), 'an unselected draft was published');
  assert.ok(!remote.some(f => f.endsWith('events/evt-foreign.json')), 'another participant\'s file was published by this tick');
  assert.equal(readFileSync(join(ch.dir, 'private-draft.txt'), 'utf8'), 'not for anyone yet\n', 'the draft bytes were touched');
  assert.equal(readFileSync(join(ch.dir, 'events', 'evt-foreign.json'), 'utf8'), JSON.stringify(foreign, null, 2));
  assert.equal(ch.remoteCommits(), before + 1);
  assert.deepEqual(r.delivery.foreign_paths.map(p => p.split('/').slice(-1)[0]).sort(), ['evt-foreign.json', 'private-draft.txt', 'scratch.md']);
  // A later quiet tick still leaves them alone.
  const again = await tick(slug);
  assert.equal(again.published_paths, 0);
  assert.equal(ch.remoteCommits(), before + 1);
});

test('git/delivery: a modified tracked file under the channel blocks delivery explicitly and is preserved; nothing is pushed (R3-H4)', async () => {
  const slug = 'git-delivery-modified';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  request(ch); sync(ch, 'request');
  const before = ch.remoteCommits();
  const edited = join(ch.dir, 'events', 'evt-002.json');           // ME's join, already on the remote
  const original = readFileSync(edited, 'utf8');
  writeFileSync(edited, original.replace('"own"', '"own (edited by hand)"'));

  const r = await tick(slug);
  assert.equal(r.timeout_actions_executed, 1, 'the bound still executes locally; delivery is what is blocked');
  assert.ok(r.delivery.blocked, 'a hand-edited committed event did not block delivery');
  assert.ok(r.delivery.blocked.paths.some(p => p.endsWith('events/evt-002.json')));
  assert.equal(ch.remoteCommits(), before, 'something was pushed past a blocked delivery');
  assert.equal(readFileSync(edited, 'utf8'), original.replace('"own"', '"own (edited by hand)"'), 'the edit was not preserved');
});

test('git/delivery: an unrelated staged entry is not committed by the tick, and an unrelated unpushed commit blocks the push and is preserved (R3-H4)', async () => {
  const slug = 'git-delivery-unrelated';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  request(ch); sync(ch, 'request');
  const before = ch.remoteCommits();
  // Unrelated index entry: README edited and staged by someone, outside the channel.
  writeFileSync(join(ch.repo, 'README.md'), 'test repo\nedited\n');
  git(ch.repo, 'add', 'README.md');

  const r = await tick(slug);
  assert.equal(r.timeout_actions_executed, 1);
  assert.equal(git(ch.repo, 'diff', '--cached', '--name-only'), 'README.md', 'the unrelated staged entry was consumed or dropped');
  assert.ok(!ch.remoteFiles().includes('README.md') || git(BASE, '--git-dir', join(BASE, `${slug}-remote.git`), 'show', 'main:README.md') === 'test repo', 'the unrelated staged edit reached the remote');
  assert.equal(ch.remoteCommits(), before + 1, 'the owned record should still have been delivered on its own');

  // Unrelated unpushed commit: someone committed outside the channel and did not push.
  git(ch.repo, 'commit', '-q', '-m', 'unrelated local work');
  const localHead = git(ch.repo, 'rev-parse', 'HEAD');
  orphanRecord(ch, slug, T0, 'evt-timeout-orphan-2');           // and this tick has owned work of its own... but it is settled, so nothing new executes
  const r2 = await tick(slug);
  assert.ok(r2.delivery.blocked, 'an unrelated unpushed commit did not block the push');
  assert.equal(ch.remoteCommits(), before + 1, 'the unrelated commit was pushed');
  assert.equal(git(ch.repo, 'log', '-1', '--format=%s', localHead), 'unrelated local work', 'the unrelated commit was not preserved');
  assert.ok(git(ch.repo, 'rev-list', '@{u}..HEAD').split('\n').filter(Boolean).length >= 1);
});


// ------------------------------------------------------------ ownership after commit, on the close routes, and at the closed exit (R3-H4 / R3-H5)

const remoteShow = (slug, path) => { try { return git(BASE, '--git-dir', join(BASE, `${slug}-remote.git`), 'show', `main:${path}`); } catch { return null; } };

test('git/delivery: a draft COMMITTED inside the channel but unpushed blocks the push and stays local — location is not ownership after commit (R3-H4)', async () => {
  const slug = 'git-delivery-committed-draft';
  const T0 = Date.now() - 12 * MIN;
  const ch = mkGitChannel(slug, T0);
  request(ch); sync(ch, 'request');
  await tick(slug);                                            // settles ME's bound and delivers it
  const before = ch.remoteCommits();
  writeFileSync(join(ch.dir, 'private-draft.txt'), 'committed by hand, never meant to travel\n');
  git(ch.repo, 'add', join(ch.dir, 'private-draft.txt'));
  git(ch.repo, 'commit', '-q', '-m', 'wip draft');
  const r = await tick(slug);                                  // quiet tick
  assert.ok(r.delivery.blocked, 'a committed draft under the channel was treated as deliverable');
  assert.equal(r.delivery.blocked.reason, 'unrelated-unpushed-commits');
  assert.equal(r.delivery.pushed, false);
  assert.equal(ch.remoteCommits(), before, 'the draft commit was pushed');
  assert.ok(!ch.remoteFiles().some(f => f.endsWith('private-draft.txt')));
  assert.equal(git(ch.repo, 'log', '-1', '--format=%s'), 'wip draft', 'the local commit was not preserved');

  // A committed hand edit to one of this participant's own events is not owned either:
  // the plugin never rewrites an event, so the author inside a modified file proves nothing.
  git(ch.repo, 'reset', '-q', '--hard', '@{u}');
  const own = join(ch.dir, 'events', 'evt-002.json');
  writeFileSync(own, readFileSync(own, 'utf8').replace('"own"', '"own (edited by hand)"'));
  git(ch.repo, 'add', own); git(ch.repo, 'commit', '-q', '-m', 'edit history');
  const r2 = await tick(slug);
  assert.equal(r2.delivery.blocked?.reason, 'unrelated-unpushed-commits', 'a committed edit to an event was pushed as owned work');
  assert.equal(ch.remoteCommits(), before);
});

test('git/delivery: the authority-boundary close delivers the close event and its renders, and nothing else in the channel (R3-H4)', async () => {
  const slug = 'git-delivery-close-boundary';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  const pc = ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });   // R1's review of M-A never arrives
  sync(ch, 'proposal');
  const before = ch.remoteCommits();
  writeFileSync(join(ch.dir, 'private-draft.txt'), 'still not for anyone\n');
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  assert.equal(r.reason, 'authority-boundary');
  const close = readEvents(ch.dir).find(e => e.type === 'close');
  const remote = ch.remoteFiles();
  assert.ok(remote.some(f => f.endsWith(`events/${close.event_id}.json`)), 'the close never reached the remote');
  assert.ok(remote.some(f => f.endsWith(`2026-09-11-${slug}/STATUS.md`)), 'the rendered STATUS.md never reached the remote');
  assert.ok(remote.some(f => f.endsWith(`2026-09-11-${slug}/events.jsonl`)));
  assert.ok(!remote.some(f => f.endsWith('private-draft.txt')), 'the close route published an unselected draft');
  assert.equal(readFileSync(join(ch.dir, 'private-draft.txt'), 'utf8'), 'still not for anyone\n');
  assert.equal(ch.remoteCommits(), before + 1);
  assert.equal(r.delivery.verified, true);
  assert.ok(r.delivery.foreign_paths.some(p => p.endsWith('private-draft.txt')));
  assert.ok(pc, 'setup');
});

test('git/delivery: an owned close interrupted before OR after commit reaches the remote on the next tick, once, and the tick still exits closed (R3-H5)', async () => {
  for (const [variant, commitFirst] of [['before-commit', false], ['after-commit', true]]) {
    const slug = `git-delivery-close-retry-${variant}`;
    const T0 = Date.now() - 20 * MIN;
    const ch = mkGitChannel(slug, T0);
    const before = ch.remoteCommits();
    ch.add(ME, 'close', 15, { final_synthesis: 'x', outcome: 'failed-safely' });   // appended by an emit that died before publishing
    if (commitFirst) { git(ch.repo, 'add', ch.dir); git(ch.repo, 'commit', '-q', '-m', 'close (push never happened)'); }
    const r = await tick(slug);
    assert.equal(r.action, 'exit', variant);
    assert.equal(r.reason, 'closed', variant);
    assert.equal(readEvents(ch.dir).filter(e => e.type === 'close').length, 1, `${variant}: a second close appeared`);
    assert.ok(ch.remoteFiles().some(f => f.endsWith('events/evt-004.json')), `${variant}: the close never reached the remote`);
    assert.equal(ch.remoteCommits(), before + 1, variant);
    assert.equal(r.delivery.pushed, true, variant);
    assert.equal(r.delivery.verified, true, variant);
    assert.equal(remoteShow(slug, `collabs/2026-09-11-${slug}/events/evt-004.json`) !== null, true);
    const again = await tick(slug);
    assert.equal(again.action, 'exit');
    assert.equal(ch.remoteCommits(), before + 1, `${variant}: a second tick published again`);
  }
});


// ------------------------------------------------------------ ownership end to end: path binding, derived content, preservation (R3-H4, fifth pass)

const manifestDir = () => join(BASE, 'delivery');
const remoteText = (slug, relInChannel) => remoteShow(slug, `collabs/2026-09-11-${slug}/${relInChannel}`);

test('git/delivery: bytes recorded for one path do not authorize another — a copy of STATUS.md under a new name is foreign (R3-H4)', async () => {
  const slug = 'git-delivery-path-binding';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'proposal');
  const closed = await tick(slug);                                   // authority-boundary close: renders STATUS.md and delivers it
  assert.equal(closed.action, 'close');
  const before = ch.remoteCommits();
  writeFileSync(join(ch.dir, 'unapproved-copy.md'), readFileSync(join(ch.dir, 'STATUS.md')));
  const r = await tick(slug);
  assert.equal(r.action, 'exit');
  assert.ok(!ch.remoteFiles().some(f => f.endsWith('unapproved-copy.md')), 'recorded bytes under an unrecorded path were published');
  assert.ok(r.delivery.foreign_paths.some(p => p.endsWith('unapproved-copy.md')));
  assert.equal(r.delivery.blocked, null);
  assert.equal(ch.remoteCommits(), before);
});

test('git/delivery: an unpublished foreign event never reaches the remote through the renders it would feed (R3-H4)', async () => {
  const slug = 'git-delivery-derived-disclosure';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'proposal');
  const MARK = 'ZZ-UNPUBLISHED-MARKER-7f3a';
  const foreign = { event_id: 'evt-005', ts: iso(T0 + 21 * MIN), author: R1, slug, type: 'turn', references: [],
    payload: { schema_version: '1.0', provenance: { emit_mode: 'interactive', harness: 'codex' }, intent: 'critique', body: `draft with ${MARK}`, signals: [], state: 'working', owner: R1, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) } };
  const raw = JSON.stringify(foreign, null, 2);
  writeFileSync(join(ch.dir, 'events', 'evt-005.json'), raw);
  const r = await tick(slug);                                        // proposer ticks; R1's review never arrived → close
  assert.equal(r.action, 'close');
  assert.ok(!ch.remoteFiles().some(f => f.endsWith('events/evt-005.json')), 'the raw foreign event was published');
  for (const f of ch.remoteFiles().filter(f => f.includes(`2026-09-11-${slug}/`))) {
    const text = remoteShow(slug, f) || '';
    assert.ok(!text.includes(MARK), `unpublished content reached the remote through ${f}`);
    assert.ok(!text.includes('evt-005') || f.endsWith('/events/evt-005.json'), `the unpublished event is referenced in ${f}`);
  }
  assert.equal(readFileSync(join(ch.dir, 'events', 'evt-005.json'), 'utf8'), raw, 'the foreign event was not preserved');
  assert.ok(remoteText(slug, 'STATUS.md'), 'the close still delivers its own STATUS.md');
});

test('git/delivery: an unrecorded existing STATUS.md is preserved, the render blocks explicitly, and the close is still delivered (R3-H4)', async () => {
  const slug = 'git-delivery-preserve-draft';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'proposal');
  const DRAFT = '# someone\'s draft status — DRAFT-MARKER-91c2\n';
  writeFileSync(join(ch.dir, 'STATUS.md'), DRAFT);
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  assert.equal(readFileSync(join(ch.dir, 'STATUS.md'), 'utf8'), DRAFT, 'the draft was overwritten by the render');
  assert.ok(r.render_blocked, 'the render did not report that it left an unknown file alone');
  assert.ok(r.render_blocked.paths.includes('STATUS.md'));
  const close = readEvents(ch.dir).find(e => e.type === 'close');
  assert.ok(ch.remoteFiles().some(f => f.endsWith(`events/${close.event_id}.json`)), 'the close itself was not delivered');
  assert.ok(!(remoteText(slug, 'STATUS.md') || '').includes('DRAFT-MARKER'), 'the draft reached the remote');
});

test('git/delivery: the ownership manifest for the channel exists after a render; corrupting THAT file fails safe — renders held, close delivered, nothing throws', async () => {
  const slug = 'git-delivery-manifest-corrupt';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'proposal');
  await render(slug, { collabDir: ch.dir, author: ME, publish: false });       // establishes the manifest for this exact channel
  const mp = deliveryManifestPath(ch.dir, ME);
  const m = JSON.parse(readFileSync(mp, 'utf8'));
  assert.ok(Array.isArray(m['STATUS.md']) && m['STATUS.md'].length === 1, `manifest for the subject channel not established: ${mp}`);
  assert.ok(Array.isArray(m['events.jsonl']));
  writeFileSync(mp, '{"STATUS.md": ["deadbeef');                                 // a torn write by an interrupted process
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  const close = readEvents(ch.dir).find(e => e.type === 'close');
  assert.ok(ch.remoteFiles().some(f => f.endsWith(`events/${close.event_id}.json`)), 'the close was not delivered');
  assert.ok(!ch.remoteFiles().some(f => f.endsWith(`2026-09-11-${slug}/STATUS.md`)), 'a render with no evidence was published');
  assert.ok(r.render_blocked?.paths.includes('STATUS.md'), 'the unaccounted-for STATUS.md was not reported as preserved');
  assert.ok(r.delivery.verified);
});

test('git/delivery: a lost manifest update only demotes — the render it forgot is preserved and listed, never published', async () => {
  const slug = 'git-delivery-manifest-lost-update';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'proposal');
  const mp = deliveryManifestPath(ch.dir, ME);
  await render(slug, { collabDir: ch.dir, author: ME, publish: false });
  const stale = readFileSync(mp, 'utf8');                                         // a concurrent writer's view, taken now
  const before = readFileSync(join(ch.dir, 'STATUS.md'));
  ch.add(ME, 'turn', 21, { intent: 'clarify', body: 'a later note, so the next render differs', signals: [], state: 'working', owner: ME, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) });
  await render(slug, { collabDir: ch.dir, author: ME, publish: false });         // a newer STATUS.md is written and recorded
  const newer = readFileSync(join(ch.dir, 'STATUS.md'));
  assert.equal(before.equals(newer), false, 'test setup: the two renders must differ');
  writeFileSync(mp, stale);                                                       // the concurrent writer lands last: the newer entry is lost
  const r = await tick(slug);                                                     // close route: render, then deliver
  assert.equal(r.action, 'close');
  assert.ok(r.render_blocked?.paths.includes('STATUS.md'), 'a render the manifest forgot must be preserved, not replaced');
  assert.equal(readFileSync(join(ch.dir, 'STATUS.md')).equals(newer), true, 'the forgotten render was overwritten');
  assert.ok(!ch.remoteFiles().some(f => f.endsWith(`2026-09-11-${slug}/STATUS.md`)), 'a forgotten render was published');
  assert.ok(before.length > 0);
});

test('git/delivery: an edited published input never reaches the remote — not through the refused tick, not through the retry after the edit is withdrawn (R3-H4)', async () => {
  const slug = 'git-delivery-edited-input-retry';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  const peer = ch.add(R1, 'turn', 10, { intent: 'critique', body: 'published peer critique', signals: [], state: 'working', owner: R1, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) });
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'peer turn and proposal');
  const MARK = 'ZZ-EDITED-INPUT-MARKER-4c19';
  const peerPath = join(ch.dir, 'events', `${peer.event_id}.json`);
  const published = readFileSync(peerPath, 'utf8');
  writeFileSync(peerPath, published.replace('published peer critique', `edited locally ${MARK}`));

  const first = await tick(slug);                                                 // proposer ticks; R1's review never arrived → close
  assert.equal(first.action, 'close');
  assert.equal(first.delivery.blocked?.reason, 'modified-tracked-files');
  assert.ok(readFileSync(peerPath, 'utf8').includes(MARK), 'the withdrawn-later edit must be preserved by us, not reverted');
  for (const f of ['STATUS.md', 'events.jsonl']) {
    assert.ok(!readFileSync(join(ch.dir, f), 'utf8').includes(MARK), `the edited input was derived into ${f}`);
  }

  writeFileSync(peerPath, published);                                             // the edit is withdrawn by its owner
  const second = await tick(slug);
  assert.equal(second.action, 'exit');
  assert.equal(second.delivery.pushed, true);
  for (const f of ch.remoteFiles().filter(f => f.includes(`2026-09-11-${slug}/`))) {
    assert.ok(!(remoteShow(slug, f) || '').includes(MARK), `the edited input reached the remote through ${f}`);
  }
});

test('git/delivery: an edited published event by the ticking participant is not an input either — author equality does not authorize rewriting history (R3-H4)', async () => {
  const slug = 'git-delivery-edited-own-input';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  const mine = ch.add(ME, 'turn', 10, { intent: 'propose', body: 'my published turn', signals: [], state: 'working', owner: ME, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) });
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'own turn and proposal');
  const MARK = 'ZZ-OWN-EDIT-MARKER-e2b7';
  const p = join(ch.dir, 'events', `${mine.event_id}.json`);
  writeFileSync(p, readFileSync(p, 'utf8').replace('my published turn', `rewritten ${MARK}`));
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  assert.equal(r.delivery.blocked?.reason, 'modified-tracked-files');
  assert.ok(!readFileSync(join(ch.dir, 'events.jsonl'), 'utf8').includes(MARK), 'an edited own event was derived into events.jsonl');
  assert.ok(!(readFileSync(join(ch.dir, 'STATUS.md'), 'utf8')).includes(MARK));
  assert.ok(readFileSync(p, 'utf8').includes(MARK), 'the edit was reverted instead of preserved');
});

test('git/delivery: an alternate file borrowing a published event\'s id is not that event — the reader returns the published bytes, and the tick REFUSES (David: fatal block on filename violations)', async () => {
  const slug = 'git-delivery-shadow-file';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  const peer = ch.add(R1, 'turn', 10, { intent: 'critique', body: 'published peer critique', signals: [], state: 'working', owner: R1, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) });
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'peer turn and proposal');
  const before = ch.remoteCommits();
  const MARK = 'ZZ-SHADOW-MARKER-a91d';
  const shadow = JSON.parse(readFileSync(join(ch.dir, 'events', `${peer.event_id}.json`), 'utf8'));
  shadow.payload.body = `shadow body ${MARK}`;
  const shadowRaw = JSON.stringify(shadow, null, 2);
  writeFileSync(join(ch.dir, 'events', '000-shadow.json'), shadowRaw);     // same id, ts, author; sorts first
  const seen = readEvents(ch.dir).find(e => e.event_id === peer.event_id);
  assert.equal(seen.payload.body, 'published peer critique', 'the reader took the alternate file\'s bytes for a published id');
  assert.equal(readEvents(ch.dir).filter(e => e.event_id === peer.event_id).length, 1);
  assert.deepEqual(eventFilenameViolations(ch.dir), ['events/000-shadow.json']);

  const r = await tick(slug);
  assert.equal(r.action, 'refused', 'a filename violation in events/ must be a hard stop');
  assert.equal(r.reason, 'event-filename-violation');
  assert.deepEqual(r.paths, ['events/000-shadow.json']);
  assert.ok(!readEvents(ch.dir).some(e => e.type === 'close'), 'the refused tick appended a close');
  assert.equal(ch.remoteCommits(), before, 'the refused tick published something');
  assert.equal(readFileSync(join(ch.dir, 'events', '000-shadow.json'), 'utf8'), shadowRaw, 'the foreign bytes were not preserved');
  assert.ok(validateEvents(readEvents(ch.dir), { collabDir: ch.dir }).errors.some(e => /event-filename-violation.*000-shadow\.json/.test(e)), 'validate did not report the violation');
});

test('git/delivery: a peer event published only as a legacy events.jsonl line is still in the rendered events.jsonl the close delivers', async () => {
  const slug = 'git-delivery-legacy-jsonl-peer';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  // A peer running a JSONL-only writer appended straight to events.jsonl; it was pushed that way.
  const line = { event_id: 'evt-legacy-peer', ts: iso(T0 + 12 * MIN), author: R1, slug, type: 'turn', references: [],
    payload: { intent: 'critique', body: 'legacy peer critique, published in events.jsonl only', signals: [] } };
  const events = readEvents(ch.dir);
  writeFileSync(join(ch.dir, 'events.jsonl'), [...events, line].map(e => JSON.stringify(e)).join('\n') + '\n');
  sync(ch, 'proposal and legacy jsonl');
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  assert.ok((remoteText(slug, 'events.jsonl') || '').includes('legacy peer critique'), 'a published legacy peer event was removed from the derived file on the remote');
  assert.ok(r.delivery.verified);
});

// ------------------------------------------------------------ one published identity, two representations (R3-H4, eighth pass)

/** Publish `line` as a line of upstream events.jsonl only — the legacy JSONL-only writer's footprint. */
function publishJsonlLine(ch, line) {
  const events = readEvents(ch.dir);
  writeFileSync(join(ch.dir, 'events.jsonl'), [...events, line].map(e => JSON.stringify(e)).join('\n') + '\n');
  sync(ch, 'legacy jsonl line');
}
const legacyTurn = (slug, T0, author, body) => ({ event_id: 'evt-legacy-x', ts: iso(T0 + 12 * MIN), author, slug, type: 'turn', references: [],
  payload: { intent: 'critique', body, signals: [] } });

for (const [who, author] of [['own-author', ME], ['peer'], ]) {
  const a = author || R1;
  test(`git/delivery: a local file that contradicts an event published only as a JSONL line (${who}) is a conflict — published content is kept, local bytes preserved, nothing of the edit delivered (R3-H4)`, async () => {
    const slug = `git-delivery-jsonl-conflict-${who}`;
    const T0 = Date.now() - 40 * MIN;
    const ch = mkGitChannel(slug, T0);
    ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
    sync(ch, 'proposal');
    const line = legacyTurn(slug, T0, a, 'published only as a jsonl line');
    publishJsonlLine(ch, line);
    assert.ok((remoteText(slug, 'events.jsonl') || '').includes('published only as a jsonl line'), 'setup: the line must be published');
    const MARK = `ZZ-JSONL-CONFLICT-${who}-5e2c`;
    const local = { ...line, payload: { ...line.payload, body: `rewritten locally ${MARK}` } };
    const localRaw = JSON.stringify(local, null, 2);
    writeFileSync(join(ch.dir, 'events', `${line.event_id}.json`), localRaw);      // same id, different content, no upstream file

    const r = await tick(slug);
    assert.equal(r.action, 'close');
    for (const f of ch.remoteFiles().filter(f => f.includes(`2026-09-11-${slug}/`))) {
      assert.ok(!(remoteShow(slug, f) || '').includes(MARK), `the local edit reached the remote through ${f}`);
    }
    assert.ok(!ch.remoteFiles().some(f => f.endsWith(`events/${line.event_id}.json`)), 'the conflicting raw file was delivered');
    assert.ok((remoteText(slug, 'events.jsonl') || '').includes('published only as a jsonl line'), 'the published line was erased from the derived file');
    assert.equal(readFileSync(join(ch.dir, 'events', `${line.event_id}.json`), 'utf8'), localRaw, 'the local conflicting bytes were not preserved');
    assert.ok(r.render_conflicts?.some(c => c.event_id === line.event_id), 'the conflict was not reported');
    assert.ok(r.delivery.foreign_paths.some(p => p.endsWith(`events/${line.event_id}.json`)), 'the conflicting file was not listed as not-ours');
  });
}

test('git/delivery: an unchanged legacy migration — a local file identical to the published JSONL line — is not a conflict and is delivered', async () => {
  const slug = 'git-delivery-jsonl-migration';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'proposal');
  const line = legacyTurn(slug, T0, ME, 'my legacy line, migrated unchanged');
  publishJsonlLine(ch, line);
  writeFileSync(join(ch.dir, 'events', `${line.event_id}.json`), JSON.stringify(line, null, 2));   // identical content, now as a file
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  assert.deepEqual(r.render_conflicts ?? [], []);
  assert.ok(ch.remoteFiles().some(f => f.endsWith(`events/${line.event_id}.json`)), 'the unchanged migration was not delivered');
  assert.ok((remoteText(slug, 'events.jsonl') || '').includes('my legacy line, migrated unchanged'));
});

test('git/delivery: an edited published peer FILE also keeps the published content in derived files while the edit is preserved locally', async () => {
  const slug = 'git-delivery-edited-file-preserves-published';
  const T0 = Date.now() - 40 * MIN;
  const ch = mkGitChannel(slug, T0);
  const peer = ch.add(R1, 'turn', 10, { intent: 'critique', body: 'published peer critique', signals: [], state: 'working', owner: R1, waiting_on: null, next_update_by: iso(T0 + 120 * MIN) });
  ch.add(ME, 'propose-close', 20, { synthesis: 's', igm_met: {} });
  sync(ch, 'peer turn and proposal');
  const p = join(ch.dir, 'events', `${peer.event_id}.json`);
  const edited = readFileSync(p, 'utf8').replace('published peer critique', 'rewritten ZZ-EDITED-FILE-9a3f');
  writeFileSync(p, edited);
  const r = await tick(slug);
  assert.equal(r.action, 'close');
  assert.equal(r.delivery.blocked?.reason, 'modified-tracked-files');
  assert.ok(readFileSync(join(ch.dir, 'events.jsonl'), 'utf8').includes('published peer critique'), 'the published turn was erased from the derived file');
  assert.ok(!readFileSync(join(ch.dir, 'events.jsonl'), 'utf8').includes('ZZ-EDITED-FILE'));
  assert.equal(readFileSync(p, 'utf8'), edited, 'the edit was not preserved');
  assert.ok(r.render_conflicts?.some(c => c.event_id === peer.event_id));
});

test.after(() => rmSync(BASE, { recursive: true, force: true }));
