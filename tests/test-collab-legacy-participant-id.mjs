/**
 * test-collab-legacy-participant-id.mjs — the compatibility read for failure class 11.
 *
 * Identity is now minted once and persisted. Every channel that already exists was joined
 * before that was true: its join events carry no `participant_id`, and their author string
 * was composed from whatever `detectHarness()` reported on the day of the join.
 *
 * So the rule is that the identity a channel ALREADY ADMITTED outranks anything this machine
 * would mint. An install that upgrades into the identity store, with its harness reading
 * meanwhile changed, must keep resolving in its old channels — otherwise the fix relocates
 * the defect instead of closing it.
 *
 * Every assertion here is paired with the guard that makes it non-vacuous: the test first
 * demonstrates that a fresh mint under this environment WOULD produce a different string.
 * Without that, "the participant still resolves" could mean nothing changed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HARNESS_ENV_VARS = ['CODEX_PLUGIN_ROOT', 'GEMINI_PLUGIN_ROOT', 'COLLAB_HARNESS_OVERRIDE'];
const FIXTURE_ENV_VARS = ['COLLAB_LOCAL_ROOT', 'COLLAB_REPOS_ROOT', 'COLLAB_IDENTITY_ROOT'];

function snapshotEnv(keys) {
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  return saved;
}
function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function freshModules(tag) {
  const q = `?fixture=${encodeURIComponent(tag)}`;
  const [helpers, tick] = await Promise.all([
    import(`../skills/collab/scripts/collab-event-helpers.mjs${q}`),
    import(`../skills/collab/scripts/collab-tick.mjs${q}`),
  ]);
  return { ...helpers, tickDeterministic: tick.tickDeterministic };
}

/**
 * A channel exactly as an older install left it: events on disk, join authored under a
 * triplet, and not one `participant_id` anywhere.
 */
function writeLegacyChannel(localRoot, slug, author) {
  const dir = join(localRoot, `2026-07-30-${slug}`);
  mkdirSync(join(dir, 'events'), { recursive: true });
  const events = [
    {
      event_id: 'evt-legacy-001-kickoff', ts: '2026-07-30T01:00:00.000Z', author, slug,
      type: 'kickoff', references: [],
      payload: {
        message: 'a channel from before participant ids existed',
        igm: { intention: 'i', goal: 'g', measure: 'm' },
        capabilities_wanted: [], wall_clock_hours: 24,
        transport: 'localhost', tick_interval_minutes: 60,
        min_collab_plugin_version: '0.0.0',
      },
    },
    {
      event_id: 'evt-legacy-002-join', ts: '2026-07-30T01:00:01.000Z', author, slug,
      type: 'join', references: ['evt-legacy-001-kickoff'],
      payload: { capability_match: [], commitment: 'originator self-join' },
    },
  ];
  for (const e of events) {
    assert.ok(!('participant_id' in e), 'fixture must not carry a participant id');
    writeFileSync(join(dir, 'events', `${e.event_id}.json`), JSON.stringify(e, null, 2));
  }
  return dir;
}

function withFixture(name, fn) {
  return async () => {
    const base = mkdtempSync(join(tmpdir(), `collab-legacy-id-${name}-`));
    const localRoot = join(base, 'local');
    const identityRoot = join(base, 'identity');
    mkdirSync(localRoot, { recursive: true });
    mkdirSync(join(base, 'projects'), { recursive: true });
    const saved = snapshotEnv([...HARNESS_ENV_VARS, ...FIXTURE_ENV_VARS]);
    try {
      process.env.COLLAB_LOCAL_ROOT = localRoot;
      process.env.COLLAB_REPOS_ROOT = join(base, 'projects');
      process.env.COLLAB_IDENTITY_ROOT = identityRoot;
      for (const k of HARNESS_ENV_VARS) delete process.env[k];
      await fn({ base, localRoot, identityRoot });
    } finally {
      restoreEnv(saved);
      rmSync(base, { recursive: true, force: true });
    }
  };
}

const WORKSPACE = 'legacy-workspace';

test('11-compat: a join with no participant_id still resolves after the harness moved',
  withFixture('resolve', async ({ base, localRoot, identityRoot }) => {
    const m = await freshModules(`${base}-resolve`);
    const machine = m.deriveMachine();

    // The channel was joined under claude-code. This install now reports gemini.
    process.env.GEMINI_PLUGIN_ROOT = join(base, 'fake-gemini-root');
    assert.equal(m.detectHarness(), 'gemini', 'fixture precondition: the harness reading must have moved');

    const legacyAuthor = `${WORKSPACE}@claude-code:${machine}`;
    const slug = 'a-channel-from-before-participant-ids-existed';
    const dir = writeLegacyChannel(localRoot, slug, legacyAuthor);

    // Non-vacuity guard. A fresh mint under THIS environment produces a different string, so
    // "it still resolves" below cannot be true by accident.
    const freshMint = m.resolveIdentity('an-unrelated-workspace');
    assert.equal(freshMint.triplet, `an-unrelated-workspace@gemini:${machine}`,
      'a fresh mint should carry the current harness — if it does not, this test proves nothing');
    assert.ok(!existsSync(join(identityRoot, `${WORKSPACE}.json`)),
      'fixture precondition: this workspace must have no identity record yet');

    // A1 — the ledger wins over the mint.
    const events = m.readEvents(dir);
    const identity = m.resolveIdentity(WORKSPACE, { events });
    assert.equal(identity.triplet, legacyAuthor,
      `identity was minted from the environment instead of adopted from the channel: got ` +
      `"${identity.triplet}", the channel admitted "${legacyAuthor}"`);
    assert.match(identity.participant_id, /^pcp-[0-9a-f-]{36}$/,
      'a participant id must be minted for the adopted identity, not left null');
    assert.equal(identity.harness, 'gemini',
      'the advisory harness must report the CURRENT reading, not the one frozen in the triplet');

    // A2 — the consequence. A participant that does not resolve loses its own membership.
    assert.equal(m.hasJoinedIdentity(events, identity), true,
      'the participant is not recognized as a member of the channel it originated');
    const tickResult = await m.tickDeterministic(slug, { workspaceId: WORKSPACE });
    assert.notEqual(tickResult.action, 'not-joined',
      `a tick on a pre-identity channel reports not-joined — upgrading the install evicted ` +
      `the participant from its own channel`);
    assert.notEqual(tickResult.action, 'version-too-low', 'the version floor masked the membership answer');

    // A3 — the adoption is durable. Re-resolving without the ledger returns the same string,
    // so the next call from any code path agrees.
    assert.equal(m.deriveTriplet(WORKSPACE), legacyAuthor,
      'the adopted identity was not persisted, so the next call re-derives from the environment');
    const rec = JSON.parse(readFileSync(join(identityRoot, `${WORKSPACE}.json`), 'utf8'));
    assert.equal(rec.triplet, legacyAuthor);
    assert.equal(rec.participant_id, identity.participant_id);
  }));

test('11-compat: one legacy channel does not relabel the participant everywhere else',
  withFixture('scoped', async ({ base, localRoot }) => {
    const m = await freshModules(`${base}-scoped`);
    const machine = m.deriveMachine();

    // This install already has an identity, minted under gemini.
    process.env.GEMINI_PLUGIN_ROOT = join(base, 'fake-gemini-root');
    const minted = m.resolveIdentity(WORKSPACE);
    assert.equal(minted.triplet, `${WORKSPACE}@gemini:${machine}`);

    // It then meets an older channel that admitted it under a different harness label.
    const legacyAuthor = `${WORKSPACE}@claude-code:${machine}`;
    assert.notEqual(legacyAuthor, minted.triplet, 'fixture precondition: the two labels must differ');
    const dir = writeLegacyChannel(localRoot, 'an-older-channel-under-another-label', legacyAuthor);
    const events = m.readEvents(dir);

    const inChannel = m.resolveIdentity(WORKSPACE, { events });
    assert.equal(inChannel.triplet, legacyAuthor, 'inside that channel we answer to what it admitted');
    assert.equal(inChannel.participant_id, minted.participant_id, 'still the same participant');

    // The global record is untouched: one legacy channel is not authority over the others.
    assert.equal(m.deriveTriplet(WORKSPACE), minted.triplet,
      'a single legacy channel rewrote the persisted identity used by every other channel');
  }));

test('11-compat: two legacy authors on one workspace+machine are ambiguous, and nothing is guessed',
  withFixture('ambiguous', async ({ base, localRoot }) => {
    const m = await freshModules(`${base}-ambiguous`);
    const machine = m.deriveMachine();
    process.env.GEMINI_PLUGIN_ROOT = join(base, 'fake-gemini-root');

    const dir = writeLegacyChannel(localRoot, 'two-legacy-authors', `${WORKSPACE}@claude-code:${machine}`);
    writeFileSync(join(dir, 'events', 'evt-legacy-003-join.json'), JSON.stringify({
      event_id: 'evt-legacy-003-join', ts: '2026-07-30T01:00:02.000Z',
      author: `${WORKSPACE}@codex:${machine}`, slug: 'two-legacy-authors',
      type: 'join', references: [], payload: { capability_match: [], commitment: 'second label' },
    }, null, 2));

    const events = m.readEvents(dir);
    const identity = m.resolveIdentity(WORKSPACE, { events });
    assert.equal(identity.triplet, `${WORKSPACE}@gemini:${machine}`,
      'two candidate authors is not evidence for either one — the resolver must mint rather than pick');
    assert.equal(identity.source, 'minted');
  }));

test('11-compat: the machine component is never treated as advisory',
  withFixture('machine', async ({ base, localRoot }) => {
    const m = await freshModules(`${base}-machine`);
    const machine = m.deriveMachine();
    process.env.GEMINI_PLUGIN_ROOT = join(base, 'fake-gemini-root');

    // Same workspace, harness differs AND the hostname drifted by punctuation. Adopting this
    // would invent an identity equivalence the ledger never established.
    const drifted = `${WORKSPACE}@claude-code:${machine}-elsewhere`;
    const dir = writeLegacyChannel(localRoot, 'a-drifted-hostname', drifted);
    const events = m.readEvents(dir);

    const identity = m.resolveIdentity(WORKSPACE, { events });
    assert.equal(identity.triplet, `${WORKSPACE}@gemini:${machine}`,
      'a drifted hostname was auto-adopted — only the harness is advisory');
    assert.equal(m.hasJoinedIdentity(events, identity), false,
      'membership was granted across a machine boundary; the repair for that is an explicit rejoin');
  }));

test('11-compat: a cursor written under the old harness-partitioned layout is read forward',
  withFixture('cursor', async ({ base }) => {
    const fakeHome = join(base, 'home');
    mkdirSync(fakeHome, { recursive: true });
    const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      const cadence = await import(`../skills/collab/scripts/collab-cadence.mjs?fixture=${encodeURIComponent(base)}`);
      const triplet = 'core-framework@claude-code:Jennifer-Aniston';
      const slug = 'some-slug';
      const opts = { machineSlug: 'test-machine', transport: 'localhost' };

      // Exactly what an older install wrote: <cursors>/<machine>/<harness>/<transport>/...
      const legacyDir = join(fakeHome, '.collab', 'cursors', 'test-machine', 'claude-code', 'localhost');
      mkdirSync(legacyDir, { recursive: true });
      const legacyFile = join(legacyDir, 'core-framework-claude-code-Jennifer-Aniston-some-slug.json');
      writeFileSync(legacyFile, JSON.stringify({ slug, last_seen_event_id: 'evt-high-water' }));

      const newPath = cadence.cursorFilePath(triplet, slug, opts);
      assert.ok(!existsSync(newPath), 'fixture precondition: the new-layout cursor must not exist yet');
      assert.deepEqual(cadence.legacyCursorFilePaths(newPath, triplet, slug), [legacyFile]);

      const state = cadence.readCursorState(newPath, triplet, slug, 'localhost');
      assert.equal(state.last_seen_event_id, 'evt-high-water',
        'the read position from the old layout was dropped — the participant silently re-reads from zero');

      // And the same recovery holds after the harness relabels, which is the whole point.
      const relabelled = 'core-framework@gemini:Jennifer-Aniston';
      const relabelledPath = cadence.cursorFilePath(relabelled, slug, opts);
      assert.equal(relabelledPath, newPath, 'the relabel produced a different cursor path');
      assert.equal(
        cadence.readCursorState(relabelledPath, relabelled, slug, 'localhost').last_seen_event_id,
        'evt-high-water');
    } finally {
      restoreEnv(savedHome);
    }
  }));
