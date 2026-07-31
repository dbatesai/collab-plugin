/**
 * test-collab-harness-identity.mjs — DG3 failure class 11.
 *
 * 11: an absent harness environment must not change participant identity.
 *
 * A participant joins a channel once. The identity that join admits is the identity every
 * later event must carry. The harness a participant happens to be running under is
 * advisory metadata — useful for a human reading the log, load-bearing for nothing — so
 * losing it must degrade the label and nothing else.
 *
 * Live reproduction: the originator's participant string read `core-gemini@claude-code`
 * for an agent running on the Gemini harness. Environment sniffing had gone wrong while
 * the identity underneath was right, and because the two are the same string, a wrong
 * sniff is indistinguishable from a different participant.
 *
 * Non-vacuity is built into the test rather than left to review. Two guards:
 *   - before asserting identity held, assert the advisory harness actually MOVED. A test
 *     that clears env vars nothing reads would otherwise pass while proving nothing.
 *   - move the harness a second time, to a third distinct value, and assert identity is
 *     still pinned. Identity surviving one env change could be coincidence; surviving two
 *     independent changes is decoupling.
 *
 * Roots come from COLLAB_LOCAL_ROOT / COLLAB_REPOS_ROOT so nothing here touches the real
 * ~/.collab or ~/Documents/Projects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WORKSPACE_ID = 'core-gemini';

// Every environment variable the harness-detection chain consults (transport.mjs
// detectHarness: CODEX > GEMINI > COLLAB_HARNESS_OVERRIDE > 'claude-code').
const HARNESS_ENV_VARS = ['CODEX_PLUGIN_ROOT', 'GEMINI_PLUGIN_ROOT', 'COLLAB_HARNESS_OVERRIDE'];
const FIXTURE_ENV_VARS = ['COLLAB_LOCAL_ROOT', 'COLLAB_REPOS_ROOT'];

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

function clearHarnessEnv() {
  for (const k of HARNESS_ENV_VARS) delete process.env[k];
}

/**
 * Import the collab modules fresh with the fixture roots bound at module-eval time.
 * collab-event-helpers.mjs captures the roots into module-level constants, so the env
 * must be set before the import and the specifier must be cache-busted per fixture.
 */
async function freshModules(tag) {
  const q = `?fixture=${encodeURIComponent(tag)}`;
  const [kickoffMod, helpers, tick] = await Promise.all([
    import(`../../skills/collab/scripts/collab-kickoff.mjs${q}`),
    import(`../../skills/collab/scripts/collab-event-helpers.mjs${q}`),
    import(`../../skills/collab/scripts/collab-tick.mjs${q}`),
  ]);
  return { kickoff: kickoffMod.kickoff, ...helpers, tickDeterministic: tick.tickDeterministic };
}

test('11: clearing every harness env var must not change participant identity', async () => {
  const base = mkdtempSync(join(tmpdir(), 'collab-harness-identity-'));
  const localRoot = join(base, 'local');
  const reposRoot = join(base, 'projects');
  mkdirSync(localRoot, { recursive: true });
  mkdirSync(reposRoot, { recursive: true });

  const savedEnv = snapshotEnv([...HARNESS_ENV_VARS, ...FIXTURE_ENV_VARS]);
  try {
    process.env.COLLAB_LOCAL_ROOT = localRoot;
    process.env.COLLAB_REPOS_ROOT = reposRoot;

    // --- Setup: join once WITH a harness environment present. ---
    clearHarnessEnv();
    process.env.GEMINI_PLUGIN_ROOT = join(base, 'fake-gemini-plugin-root');

    const m = await freshModules(base);
    const harnessAtJoin = m.detectHarness();
    assert.equal(harnessAtJoin, 'gemini', 'fixture precondition: join must happen under a non-default harness');

    const r = await m.kickoff('class eleven identity under an absent harness environment', {
      workspaceId: WORKSPACE_ID,
      transport: 'localhost',
      tickIntervalMinutes: 1,
      // Pin the floor so a later tick cannot return `version-too-low` and mask the
      // membership answer this test is actually asking for.
      minCollabPluginVersion: '0.0.0',
    });

    const joinedEvents = m.readEvents(r.dir);
    const joinEvent = joinedEvents.find(e => e.type === 'join');
    assert.ok(joinEvent, 'setup precondition: kickoff must persist a self-join event');
    const admittedIdentity = joinEvent.author; // the identity this channel admitted

    // --- Action: clear every harness-identifying env var, then emit. ---
    clearHarnessEnv();

    // Non-vacuity guard #1. If the advisory harness did not move, the identity assertion
    // below would pass because nothing changed, not because the two are decoupled.
    const harnessAfterClear = m.detectHarness();
    assert.notEqual(
      harnessAfterClear, harnessAtJoin,
      'clearing the harness env vars did not change the advisory harness — the rest of this ' +
      'test would then prove nothing about decoupling',
    );

    // A1 — identity is unchanged. deriveTriplet is the identity function every emit path
    // calls (kickoff, tick, loop, route), so this is the value a post-clear event is
    // authored under.
    const identityAfterClear = m.deriveTriplet(WORKSPACE_ID);
    assert.equal(
      identityAfterClear, admittedIdentity,
      `participant identity changed when the harness environment went away: admitted as ` +
      `"${admittedIdentity}", now emitting as "${identityAfterClear}". Identity re-derived ` +
      `from environment sniffing is not identity.`,
    );

    // A1, consequence — the identity change has teeth, so assert on the consequence too,
    // not only on the string. A participant whose identity moved loses its own membership.
    assert.equal(
      m.hasJoined(joinedEvents, identityAfterClear), true,
      `the participant is no longer recognized as a member of its own channel after the ` +
      `harness env was cleared (looked for "${identityAfterClear}"; the channel admitted ` +
      `"${admittedIdentity}")`,
    );

    const tickResult = await m.tickDeterministic(r.slug, { workspaceId: WORKSPACE_ID });
    assert.notEqual(
      tickResult.action, 'not-joined',
      `a tick after the harness env was cleared reports not-joined — the participant was ` +
      `evicted from its own channel by an environment change`,
    );

    // A2 — the advisory harness may degrade while identity does not. Asserted by moving
    // the harness a SECOND time, to a third distinct value, and re-checking identity.
    // Surviving one env change could be coincidence; surviving two is decoupling.
    process.env.COLLAB_HARNESS_OVERRIDE = 'some-other-harness';
    const harnessRelabelled = m.detectHarness();
    assert.equal(harnessRelabelled, 'some-other-harness', 'the advisory harness must be free to move');
    assert.notEqual(harnessRelabelled, harnessAfterClear, 'second harness move must be a distinct value');

    assert.equal(
      m.deriveTriplet(WORKSPACE_ID), admittedIdentity,
      `participant identity tracked a second, unrelated harness relabel — the advisory ` +
      `harness field and the participant identity are the same value, so any wrong sniff ` +
      `is indistinguishable from a different participant`,
    );
  } finally {
    restoreEnv(savedEnv);
    rmSync(base, { recursive: true, force: true });
  }
});
