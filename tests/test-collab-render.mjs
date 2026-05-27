import { test } from 'node:test';
import assert from 'node:assert/strict';

let buildStatusMd, buildTurnMd;
let findActiveProposeClose;
try {
  ({ buildStatusMd, buildTurnMd } = await import('../skills/collab/scripts/collab-render.mjs'));
  ({ findActiveProposeClose } = await import('../skills/collab/scripts/collab-event-helpers.mjs'));
} catch {
  buildStatusMd = buildTurnMd = findActiveProposeClose = () => { throw new Error('not implemented'); };
}

const BASE = [
  { event_id:'evt-001', ts:'2026-05-25T10:00:00Z', author:'core-framework@claude-code:home',
    slug:'test-collab', type:'kickoff', references:[],
    payload:{ message:'test', wall_clock_hours:24,
      igm:{ intention:'validate arch', goal:'go/no-go', measure:'explicit yes or no' },
      capabilities_wanted:['architecture-review'] } },
  { event_id:'evt-002', ts:'2026-05-25T10:30:00Z', author:'bblens@claude-code:work',
    slug:'test-collab', type:'join', references:['evt-001'],
    payload:{ capability_match:['bblens-context'], commitment:'review from BBLens' } },
];

test('buildStatusMd includes slug in title', () => {
  assert.ok(buildStatusMd(BASE, 'test-collab').includes('test-collab'));
});
test('buildStatusMd shows active state', () => {
  assert.ok(buildStatusMd(BASE, 'test-collab').toLowerCase().includes('active'));
});
test('buildStatusMd shows IGM intention', () => {
  assert.ok(buildStatusMd(BASE, 'test-collab').includes('validate arch'));
});
test('buildStatusMd shows participant', () => {
  const md = buildStatusMd(BASE, 'test-collab');
  assert.ok(md.includes('core-framework') || md.includes('bblens'));
});
test('buildStatusMd shows closed on close event', () => {
  const events = [...BASE, { event_id:'evt-003', ts:'2026-05-25T12:00:00Z',
    author:'core-framework@claude-code:home', slug:'test-collab', type:'close', references:[],
    payload:{ final_synthesis:'done', outcome:'converged' } }];
  const md = buildStatusMd(events, 'test-collab');
  assert.ok(md.toLowerCase().includes('closed') || md.toLowerCase().includes('converged'));
});
test('buildTurnMd includes author', () => {
  const e = { event_id:'evt-003', ts:'2026-05-25T11:00:00Z', author:'core-framework@claude-code:home',
    slug:'test-collab', type:'turn', references:[], payload:{ intent:'propose', body:'looks solid', signals:[] } };
  assert.ok(buildTurnMd(e).includes('core-framework'));
});
test('buildTurnMd includes body', () => {
  const e = { event_id:'evt-003', ts:'2026-05-25T11:00:00Z', author:'core-framework@claude-code:home',
    slug:'test-collab', type:'turn', references:[], payload:{ intent:'critique', body:'needs work', signals:['confidence-low'] } };
  assert.ok(buildTurnMd(e).includes('needs work'));
});
test('findActiveProposeClose null when none', () => {
  assert.equal(findActiveProposeClose(BASE), null);
});
test('findActiveProposeClose returns active propose-close', () => {
  const events = [...BASE, { event_id:'evt-003', ts:'2026-05-25T11:00:00Z',
    author:'core-framework@claude-code:home', slug:'test-collab', type:'propose-close', references:[],
    payload:{ synthesis:'looks good', igm_met:{} } }];
  const r = findActiveProposeClose(events);
  assert.ok(r !== null);
  assert.equal(r.type, 'propose-close');
});
test('findActiveProposeClose null after object', () => {
  const events = [...BASE,
    { event_id:'evt-003', ts:'2026-05-25T11:00:00Z', author:'core-framework@claude-code:home',
      slug:'test-collab', type:'propose-close', references:[], payload:{ synthesis:'x', igm_met:{} } },
    { event_id:'evt-004', ts:'2026-05-25T11:30:00Z', author:'bblens@claude-code:work',
      slug:'test-collab', type:'object', references:['evt-003'], payload:{ reason:'not done' } }];
  assert.equal(findActiveProposeClose(events), null);
});

test('render writes events.jsonl from events/ dir', async () => {
  const { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { appendEvent } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  const { render } = await import('../skills/collab/scripts/collab-render.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'collab-render-jsonl-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a@cc:m5', slug: 'test-render', type: 'kickoff', references: [], payload: { transport: 'localhost' } });
  appendEvent(dir, { event_id: 'evt-202605250923-hk-bbbb', ts: '2026-05-25T09:23:00Z', author: 'a@cc:m5', slug: 'test-render', type: 'join', references: ['evt-202605250922-hk-aaaa'], payload: {} });

  // Call render with collabDir override and dryRun:true so it doesn't try git ops
  await render('test-render', { collabDir: dir, dryRun: true });

  assert.ok(existsSync(join(dir, 'events.jsonl')), 'events.jsonl should be written');
  const jsonl = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(jsonl.length, 2);
  assert.ok(existsSync(join(dir, 'STATUS.md')));

  rmSync(dir, { recursive: true, force: true });
});

test('render skips git on localhost transport', async () => {
  // Mostly a smoke test that the function doesn't throw when transport is localhost
  // and there's no git repo around. By calling without dryRun:true and ensuring the
  // function completes, we verify the isGitTransport guard correctly skips the git path.
  const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { appendEvent } = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  const { render } = await import('../skills/collab/scripts/collab-render.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'collab-render-no-git-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a@cc:m5', slug: 'test-no-git', type: 'kickoff', references: [], payload: { transport: 'localhost' } });

  // Should complete without throwing despite no git repo and no dryRun
  await render('test-no-git', { collabDir: dir, author: 'a@cc:m5' });

  rmSync(dir, { recursive: true, force: true });
});
