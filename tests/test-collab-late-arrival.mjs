/**
 * test-collab-late-arrival.mjs — DG3 failure class 6.
 *
 * 6: a late-arriving event with an OLDER timestamp must still be delivered.
 *
 * A peer's event can land in the store after a sync that already consumed newer events —
 * git fetch order, a slow legacy writer, a reconciled foreign surface. Its timestamp is
 * behind the cursor's high-water mark. It must still reach the receive cycle and still
 * change what the cycle decides.
 *
 * A1: the late event is delivered exactly once, in causal (timestamp) position, and the
 *     receive cycle acts on it — proven by a routed artifact the cycle emits BECAUSE of it.
 * A2: delivery happens with the cursor left exactly where it was. Nothing resets it, and
 *     the delivered set is not a function of the cursor's value — a high-water cursor
 *     silently skips the event, and this test must catch that rather than tolerate it.
 *
 * The load-bearing assertion is the emitted chase, not the presence of the event in the
 * store: a high-water filter in the receive path leaves the file on disk untouched while
 * the cycle never sees it. The zero-chase control below is what makes that assertion mean
 * something — without it, a chase that fires regardless would prove nothing.
 *
 * Roots come from COLLAB_LOCAL_ROOT / COLLAB_REPOS_ROOT and HOME, so nothing here touches
 * the real ~/.collab, its cursors, or ~/Documents/Projects.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The collab roots are module-level constants, so the env has to be bound BEFORE the
// scripts are first imported — hence the temp fixture and the dynamic imports here.
const BASE = mkdtempSync(join(tmpdir(), 'collab-late-arrival-'));
const PREV = {
  local: process.env.COLLAB_LOCAL_ROOT,
  repos: process.env.COLLAB_REPOS_ROOT,
  home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
};
const LOCAL_ROOT = join(BASE, 'local');
const FAKE_HOME = join(BASE, 'home');
process.env.COLLAB_LOCAL_ROOT = LOCAL_ROOT;
process.env.COLLAB_REPOS_ROOT = join(BASE, 'projects');
process.env.HOME = FAKE_HOME;             // cursor files live at <home>/.collab/cursors/...
process.env.USERPROFILE = FAKE_HOME;
for (const d of [LOCAL_ROOT, process.env.COLLAB_REPOS_ROOT, FAKE_HOME]) mkdirSync(d, { recursive: true });

const { readEvents, appendEvent } =
  await import('../skills/collab/scripts/collab-event-helpers.mjs');
const { tickDeterministic } = await import('../skills/collab/scripts/collab-tick.mjs');
const { cursorFilePath, readCursorState, writeCursorState } =
  await import('../skills/collab/scripts/collab-cadence.mjs');

after(() => {
  process.env.COLLAB_LOCAL_ROOT = PREV.local;
  process.env.COLLAB_REPOS_ROOT = PREV.repos;
  process.env.HOME = PREV.home;
  process.env.USERPROFILE = PREV.userprofile;
  rmSync(BASE, { recursive: true, force: true });
});

const SELF = 'late-self@claude-code:tester';
const PEER = 'late-peer@claude-code:tester';

// Ids are ordered a/b/c/z so directory order (alphabetical) puts the late arrival LAST,
// while its timestamp puts it in the middle. A reader that assumes files arrive in
// timestamp order sees the straggler after the high-water and drops it.
const ID_T1 = 'evt-a-0001-kickoff';
const ID_T2 = 'evt-b-0002-join-self';
const ID_T3 = 'evt-c-0003-join-peer';
const ID_LATE = 'evt-z-0004-late-peer-turn';

const NOW = Date.now();
const ago = (min) => new Date(NOW - min * 60 * 1000).toISOString();
const T1 = ago(40);
const T2 = ago(30);
const T3 = ago(20);              // the cursor's high-water
const LATE_TS = T2;              // strictly older than T3 — the whole point of class 6
const OVERDUE = ago(15);         // the peer's commitment, already blown past the 5-min grace

/**
 * Build a channel whose cursor has consumed t1, t2, t3.
 * @param {string} slug — unique per channel; the local root is scanned by slug
 * @param {boolean} withCursor — write the cursor file at the t3 high-water
 */
function mkChannel(slug, { withCursor = true } = {}) {
  const dir = join(LOCAL_ROOT, `2026-07-30-${slug}`);
  mkdirSync(join(dir, 'events'), { recursive: true });

  const base = (id, ts, author, type, payload) => ({
    event_id: id, ts, author, slug, type, references: [], payload,
  });
  appendEvent(dir, base(ID_T1, T1, SELF, 'kickoff', {
    message: `fixture ${slug}`,
    igm: { intention: 'i', goal: 'g', measure: 'm' },
    transport: 'localhost',
    wall_clock_hours: 24,
    tick_interval_minutes: 60,
  }));
  appendEvent(dir, base(ID_T2, T2, SELF, 'join', { capability_match: [], commitment: 'originator self-join' }));
  appendEvent(dir, base(ID_T3, T3, PEER, 'join', { capability_match: [], commitment: 'peer joins' }));

  const cursorPath = cursorFilePath(SELF, slug, { transport: 'localhost' });
  if (withCursor) {
    const state = readCursorState(cursorPath, SELF, slug, 'localhost');
    state.last_seen_event_id = ID_T3;
    writeCursorState(cursorPath, state);
  }
  return { dir, slug, cursorPath };
}

/** The peer's turn that lands late, carrying a commitment it has already missed. */
function lateEvent(slug) {
  return {
    event_id: ID_LATE, ts: LATE_TS, author: PEER, slug, type: 'turn', references: [ID_T1],
    payload: {
      intent: 'propose',
      body: 'peer turn that landed after the sync that already read newer events',
      next_update_by: OVERDUE,
      signals: [],
    },
  };
}

const idsOf = (dir) => readEvents(dir).map(e => e.event_id);
const chasesFor = (dir, participant) => readEvents(dir).filter(e =>
  e.type === 'turn' && Array.isArray(e.payload?.signals) &&
  e.payload.signals.includes('chase') && e.payload.signals.includes(participant));

test('6: an event older than the cursor high-water is delivered, and the cycle acts on it', async () => {
  const slug = 'late-arrival-delivered';
  const { dir, cursorPath } = mkChannel(slug);

  // Fixture guards. Without these the test could pass for reasons that have nothing to do
  // with late arrival.
  assert.deepEqual(idsOf(dir), [ID_T1, ID_T2, ID_T3], 'fixture: the consumed set must be exactly t1,t2,t3');
  assert.equal(
    JSON.parse(readFileSync(cursorPath, 'utf8')).last_seen_event_id, ID_T3,
    'fixture: the cursor must sit at the newest event before the late arrival',
  );
  assert.ok(LATE_TS < T3, 'fixture: the late event must be older than the cursor high-water');

  appendEvent(dir, lateEvent(slug));

  const r = await tickDeterministic(slug, { triplet: SELF });

  // A1 — delivered exactly once, content intact.
  const delivered = readEvents(dir).filter(e => e.event_id === ID_LATE);
  assert.equal(delivered.length, 1, `late event delivered ${delivered.length} times, expected exactly 1`);
  assert.equal(delivered[0].author, PEER, 'late event authorship was rewritten');
  assert.equal(delivered[0].ts, LATE_TS, 'late event timestamp was rewritten to make it look current');

  // A1 — and the cycle actually consumed it. This is the assertion a high-water filter in
  // the receive path fails: the file stays on disk, but the cycle never sees it, so the
  // missed commitment it carries is never chased.
  assert.equal(
    r.chase_events_emitted, 1,
    `receive cycle emitted ${r.chase_events_emitted} chases; the late event carries a blown ` +
    'commitment, so a cycle that saw it must emit exactly one — zero means it was skipped',
  );
  const chases = chasesFor(dir, PEER);
  assert.equal(chases.length, 1, 'no routed chase artifact naming the peer — delivery left no record');
  assert.ok(
    chases[0].references.includes(ID_LATE),
    `the chase does not reference the late event (${JSON.stringify(chases[0].references)}) — ` +
    'it was triggered by something else, so it proves nothing about late delivery',
  );

  // A2 — nothing reset or advanced the cursor to make this work.
  assert.equal(
    JSON.parse(readFileSync(cursorPath, 'utf8')).last_seen_event_id, ID_T3,
    'the cursor moved during the cycle — delivery must not require rewinding or advancing it',
  );
});

test('6 control: with no late event, the same cycle emits zero chases', async () => {
  // Without this, the chase assertion above could pass on a cycle that chases unconditionally.
  const slug = 'late-arrival-control';
  const { dir } = mkChannel(slug);

  const r = await tickDeterministic(slug, { triplet: SELF });

  assert.equal(r.chase_events_emitted, 0, 'the cycle chases with no late event present — the chase assertion is vacuous');
  assert.equal(chasesFor(dir, PEER).length, 0, 'a chase artifact exists with nothing to chase');
});

test('6: the late event is delivered in causal position, not appended at the end', async () => {
  const slug = 'late-arrival-ordering';
  const { dir } = mkChannel(slug);
  appendEvent(dir, lateEvent(slug));

  await tickDeterministic(slug, { triplet: SELF });

  const ids = idsOf(dir);
  assert.ok(ids.includes(ID_LATE), 'late event absent from the delivered set');
  assert.ok(
    ids.indexOf(ID_LATE) < ids.indexOf(ID_T3),
    `late event delivered out of causal position: ${JSON.stringify(ids)} — it is older than ${ID_T3} ` +
    'and must sort before it, not land wherever it happened to arrive',
  );
  assert.ok(ids.indexOf(ID_T1) < ids.indexOf(ID_LATE), 'late event sorted before an event genuinely older than it');
});

test('6: a second cycle does not deliver the late event again', async () => {
  const slug = 'late-arrival-once';
  const { dir } = mkChannel(slug);
  appendEvent(dir, lateEvent(slug));

  await tickDeterministic(slug, { triplet: SELF });
  await tickDeterministic(slug, { triplet: SELF });

  const n = readEvents(dir).filter(e => e.event_id === ID_LATE).length;
  assert.equal(
    n, 1,
    `late event present ${n} times after two cycles, expected exactly 1 — ` +
    (n === 0 ? 'the repeat cycle dropped it' : 'the repeat cycle duplicated it'),
  );
  const files = readdirSync(join(dir, 'events')).filter(f => f.endsWith('.json') && !f.startsWith('.'));
  assert.equal(
    files.filter(f => f.includes(ID_LATE)).length, 1,
    `duplicate event files for the late arrival: ${JSON.stringify(files)}`,
  );
});

test('6 (A2): the delivered set does not depend on the cursor — same result with the cursor absent', async () => {
  // The mechanism assertion. Class 6 is not "the event happened to survive"; it is
  // "delivery is not a function of the cursor's position". Two identical channels, one
  // with the cursor parked on the newest event and one with no cursor at all, must
  // deliver the same thing. A high-water read makes these two diverge.
  const withCursor = mkChannel('late-arrival-cursored');
  const noCursor = mkChannel('late-arrival-uncursored', { withCursor: false });
  assert.ok(existsSync(withCursor.cursorPath), 'fixture: cursored channel has no cursor file');
  assert.ok(!existsSync(noCursor.cursorPath), 'fixture: uncursored channel unexpectedly has a cursor file');

  appendEvent(withCursor.dir, lateEvent(withCursor.slug));
  appendEvent(noCursor.dir, lateEvent(noCursor.slug));

  const a = await tickDeterministic(withCursor.slug, { triplet: SELF });
  const b = await tickDeterministic(noCursor.slug, { triplet: SELF });

  const fixtureIds = (dir) => idsOf(dir).filter(id => [ID_T1, ID_T2, ID_T3, ID_LATE].includes(id));
  assert.deepEqual(
    fixtureIds(withCursor.dir), fixtureIds(noCursor.dir),
    'the delivered set changed with the cursor present — delivery is a function of the cursor, ' +
    'which is exactly the high-water skip class 6 forbids',
  );
  assert.equal(
    a.chase_events_emitted, b.chase_events_emitted,
    `the cycle behaved differently with a cursor (${a.chase_events_emitted}) than without ` +
    `(${b.chase_events_emitted}) — the cursor is gating what the cycle sees`,
  );
  assert.equal(a.chase_events_emitted, 1, 'neither channel acted on the late event — both were skipped');
});
