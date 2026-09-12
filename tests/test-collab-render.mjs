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

// ------------------------------------------------------------ eligibility v1: Measures + Waiting

const R1 = 'core-codex@codex:host';
const R2 = 'core-gemini@antigravity:host';
const P = 'core-framework@claude-code:home';
const MEASURED = [
  { event_id:'evt-001', ts:'2026-09-11T10:00:00Z', author:P, slug:'m', type:'kickoff', references:[],
    payload:{ message:'m', wall_clock_hours:24, tick_interval_minutes:5, igm:{ intention:'i', goal:'g', measure:'x' }, capabilities_wanted:['review'],
      ratified_completion_measures:[
        { id:'M-A', description:'adapter A conforms', requires_review_from:R1 },
        { id:'M-B', description:'adapter B conforms', requires_review_from:R1 },
        { id:'M-C', description:'Windows run is clean', requires_review_from:R2 } ] } },
  { event_id:'evt-002', ts:'2026-09-11T10:00:00Z', author:P, slug:'m', type:'join', references:['evt-001'], payload:{ capability_match:[], commitment:'own' } },
  { event_id:'evt-003', ts:'2026-09-11T10:01:00Z', author:R1, slug:'m', type:'join', references:['evt-001'], payload:{ capability_match:[], commitment:'review', owes_review:['M-A','M-B'] } },
  { event_id:'evt-004', ts:'2026-09-11T10:02:00Z', author:R2, slug:'m', type:'join', references:['evt-001'], payload:{ capability_match:[], commitment:'review', owes_review:['M-C'] } },
];
const row = (md, id) => md.split('\n').find(l => l.startsWith(`| ${id} |`));

test('status/measures: every declared measure has a row with reviewer, state, and scope', () => {
  const events = [...MEASURED,
    { event_id:'evt-005', ts:'2026-09-11T10:10:00Z', author:R1, slug:'m', type:'ratify', references:[], payload:{ measures:['M-A'] } },
    { event_id:'evt-006', ts:'2026-09-11T10:11:00Z', author:R2, slug:'m', type:'object', references:[], payload:{ reason:'red on Windows', measures:['M-C'] } }];
  const md = buildStatusMd(events, 'm');
  assert.ok(md.includes('## Measures'), md);
  assert.match(row(md, 'M-A'), new RegExp(`\\| ${R1} \\| ratified \\| scoped \\|`));
  assert.match(row(md, 'M-B'), new RegExp(`\\| ${R1} \\| unmet \\| — \\|`));
  assert.match(row(md, 'M-C'), new RegExp(`\\| ${R2} \\| objected \\| scoped \\|`));
  assert.ok(md.includes('red on Windows'), 'the objection reason is part of the record');
});

test('status/measures: a legacy-shaped credit is labeled legacy', () => {
  const events = [...MEASURED,
    { event_id:'evt-005', ts:'2026-09-11T10:10:00Z', author:P, slug:'m', type:'propose-close', references:[], payload:{ synthesis:'s', igm_met:{} } },
    { event_id:'evt-006', ts:'2026-09-11T10:11:00Z', author:R1, slug:'m', type:'ratify', references:['evt-005'], payload:{} }];
  const md = buildStatusMd(events, 'm');
  assert.match(row(md, 'M-A'), /\| ratified \| legacy \|/);
  assert.match(row(md, 'M-B'), /\| ratified \| legacy \|/);
});

test('status/measures: a legacy ledger renders no Measures section (control)', () => {
  assert.ok(!buildStatusMd(BASE, 'test-collab').includes('## Measures'));
});

test('status/waiting: an open request is a row; a delivered one is gone; no open requests → no section', () => {
  const req = { event_id:'evt-005', ts:'2026-09-11T10:10:00Z', author:P, slug:'m', type:'turn', references:[],
    payload:{ intent:'probe', body:'please review M-A', signals:[], state:'blocked', owner:R1, waiting_on:R1, next_update_by:'2026-09-11T10:40:00Z', on_timeout:'proceed-alone' } };
  const md = buildStatusMd([...MEASURED, req], 'm');
  assert.ok(md.includes('## Waiting'), md);
  const line = md.split('\n').find(l => l.includes('evt-005'));
  assert.ok(line, 'the request row is missing');
  assert.match(line, new RegExp(`${P} → ${R1}`));
  assert.ok(line.includes('2026-09-11T10:40:00Z') && line.includes('proceed-alone') && line.includes('requested'), line);

  const delivered = { event_id:'evt-006', ts:'2026-09-11T10:20:00Z', author:R1, slug:'m', type:'turn', references:['evt-005'],
    payload:{ intent:'synthesize', body:'reviewed', signals:['delivered'], state:'working', owner:R1, waiting_on:null } };
  const md2 = buildStatusMd([...MEASURED, req, delivered], 'm');
  assert.ok(!md2.includes('## Waiting'), 'a delivered request is still shown as waiting');
  assert.ok(!buildStatusMd(MEASURED, 'm').includes('## Waiting'));
});

test('status/close: a close carrying a contract receipt prints it', () => {
  const events = [...MEASURED,
    { event_id:'evt-005', ts:'2026-09-11T11:00:00Z', author:P, slug:'m', type:'close', references:[],
      payload:{ final_synthesis:'x', outcome:'complete-to-authority-boundary',
        ratified_measures:[{ id:'M-A', by:R1, scope:'scoped' }], objected_measures:[],
        unmet_ratified_measures:[{ id:'M-B', requires_review_from:R1 }, { id:'M-C', requires_review_from:R2 }],
        missing_reviews_from:[R1, R2], note:'Closed via the stall net.' } }];
  const md = buildStatusMd(events, 'm');
  assert.ok(md.includes('closed — complete-to-authority-boundary'));
  assert.ok(md.includes('Unmet: M-B, M-C'), md);
  assert.ok(md.includes(`Missing reviews from: ${R1}, ${R2}`), md);
  assert.ok(md.includes('Closed via the stall net.'));
});
