/**
 * test-collab-symlink-transport.mjs — DG3 failure classes 1a and 1b.
 *
 * 1a: a symlinked repo root must not hide a transport. `Dirent.isDirectory()` reflects
 *     lstat, so it is FALSE for a symlink — a repo-root scan that filters on it skips
 *     symlinked repos entirely and every channel inside them becomes unresolvable.
 * 1b: an explicit unresolved slug or PIN must never be convertible into `kickoff`, and
 *     must never create a channel as a side effect of failing to find one.
 *
 * Live reproduction: ~/Documents/Projects/files is a symlink. PIN 650408 resolved to
 * route "fuzzy" and the managed loop found no collab, while the channel existed the
 * whole time.
 *
 * Roots come from COLLAB_REPOS_ROOT / COLLAB_LOCAL_ROOT so nothing here touches the
 * real ~/.collab or ~/Documents/Projects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PIN = '424242';
const SLUG = 'symlinked-repo-channel';
const DATED = `2026-07-30-${SLUG}`;
const TRIPLET = 'test-ws@claude-code:tester';

const LOCAL_PIN = '515151';
const LOCAL_SLUG = 'a-localhost-only-channel';

/**
 * Build a fixture with a REAL repo and a SYMLINKED repo, each holding one channel.
 * Layout:
 *   <root>/projects/realrepo/collabs/<dated>/events/evt-001.json
 *   <root>/elsewhere/linked/collabs/<dated-2>/events/evt-001.json
 *   <root>/projects/linkedrepo -> <root>/elsewhere/linked      (symlink)
 */
function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'collab-symlink-'));
  const projects = join(base, 'projects');
  const linkTarget = join(base, 'elsewhere', 'linked');

  const writeChannel = (repoRoot, dated, pin, slug) => {
    const evDir = join(repoRoot, 'collabs', dated, 'events');
    mkdirSync(evDir, { recursive: true });
    const kickoff = {
      event_id: 'evt-001',
      ts: '2026-07-30T00:00:00.000Z',
      author: TRIPLET,
      slug,
      type: 'kickoff',
      references: [],
      payload: { message: 'fixture', pin, wall_clock_hours: 24 },
    };
    writeFileSync(join(evDir, 'evt-001.json'), JSON.stringify(kickoff, null, 2));
  };

  writeChannel(join(projects, 'realrepo'), '2026-07-30-real-repo-channel', '111111', 'real-repo-channel');
  writeChannel(linkTarget, DATED, PIN, SLUG);

  mkdirSync(projects, { recursive: true });
  symlinkSync(linkTarget, join(projects, 'linkedrepo'), 'dir');

  return { base, projects };
}

/** Import collab-route fresh with the fixture roots bound at module-eval time. */
async function freshRoute(projects, localRoot) {
  process.env.COLLAB_REPOS_ROOT = projects;
  process.env.COLLAB_LOCAL_ROOT = localRoot;
  // Cache-bust so module-level root constants re-evaluate against this fixture.
  return import(`../skills/collab/scripts/collab-route.mjs?fixture=${encodeURIComponent(projects)}`);
}

test('1a: a symlinked repo root is scanned, and its channel resolves by slug and by PIN', async () => {
  const { base, projects } = makeFixture();
  const localRoot = join(base, 'no-local');
  const prev = { r: process.env.COLLAB_REPOS_ROOT, l: process.env.COLLAB_LOCAL_ROOT };
  try {
    const route = await freshRoute(projects, localRoot);
    const state = route.buildStateFromDisk(TRIPLET);

    // The assertion that actually catches the defect: the symlinked repo must appear
    // in the scanned-transport list. Asserting only "resolution didn't throw" would
    // pass against the broken code, which silently returned a smaller transport set.
    assert.ok(
      Object.keys(state.byTransport).includes('github:linkedrepo'),
      `symlinked repo missing from scanned transports: ${JSON.stringify(Object.keys(state.byTransport))}`,
    );

    // And the channel inside it must be discoverable both ways.
    assert.equal(state.pinIndex.get(PIN), SLUG, 'PIN did not resolve to the slug');
    assert.ok(
      state.byTransport['github:linkedrepo'].existsActive.has(SLUG),
      'channel in symlinked repo not marked active',
    );

    // Control: the real (non-symlinked) repo still works, so a passing test cannot be
    // explained by the scanner having been loosened into matching everything.
    assert.ok(Object.keys(state.byTransport).includes('github:realrepo'));
  } finally {
    process.env.COLLAB_REPOS_ROOT = prev.r; process.env.COLLAB_LOCAL_ROOT = prev.l;
    rmSync(base, { recursive: true, force: true });
  }
});

test('1b: an explicit unresolved slug or PIN never becomes kickoff and never creates a channel', async () => {
  const { base, projects } = makeFixture();
  const localRoot = join(base, 'no-local');
  const prev = { r: process.env.COLLAB_REPOS_ROOT, l: process.env.COLLAB_LOCAL_ROOT };
  try {
    const route = await freshRoute(projects, localRoot);

    const before = readdirSync(join(projects, 'realrepo', 'collabs')).sort();

    const state = route.buildStateFromDisk(TRIPLET);
    for (const msg of ['look at slug totally-absent-slug-xyz', '999999']) {
      const r = route.detectAction(msg, state);
      assert.notEqual(
        r.route, 'kickoff',
        `explicit unresolved reference "${msg}" routed to kickoff — this silently forks a parallel channel`,
      );
    }

    // A failed lookup must have zero side effects on the store.
    const after = readdirSync(join(projects, 'realrepo', 'collabs')).sort();
    assert.deepEqual(after, before, 'a failed resolution created or removed a channel');
  } finally {
    process.env.COLLAB_REPOS_ROOT = prev.r; process.env.COLLAB_LOCAL_ROOT = prev.l;
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Class 1c — a channel must be resolvable by bare slug and bare PIN regardless of which
 * transport it lives on.
 *
 * `/collab` SKILL.md: "On join, tick, status, and abort, the route script resolves the
 * transport from disk by finding the slug across all known transports — so the prefix is
 * informational and can be omitted." The code scoped the lookup to a single transport,
 * defaulting to github:files, so a localhost channel returned `fuzzy` unless the caller
 * happened to pass the `localhost` prefix.
 *
 * Live reproduction (D9): the WP4 review channel was created on localhost per the ratified
 * class-25 rule, and then could not be found by its own slug or PIN. A peer told "look at
 * slug X" gets fuzzy, and the guidance invites treating fuzzy as kickoff — which forks a
 * duplicate channel. The ratified same-machine transport was the one the router could not
 * find by default.
 */
function makeLocalFixture() {
  const base = mkdtempSync(join(tmpdir(), 'collab-xtransport-'));
  const localRoot = join(base, 'local');
  const projects = join(base, 'projects');
  // A git repo root that exists but does NOT contain the localhost slug, so a passing
  // test cannot be explained by the github view accidentally holding it.
  mkdirSync(join(projects, 'somerepo', 'collabs'), { recursive: true });

  const evDir = join(localRoot, `2026-07-30-${LOCAL_SLUG}`, 'events');
  mkdirSync(evDir, { recursive: true });
  const kickoff = {
    event_id: 'evt-001', ts: '2026-07-30T00:00:00.000Z', author: TRIPLET,
    slug: LOCAL_SLUG, type: 'kickoff', references: [],
    payload: { message: 'fixture', pin: LOCAL_PIN, wall_clock_hours: 24 },
  };
  writeFileSync(join(evDir, 'evt-001.json'), JSON.stringify(kickoff, null, 2));
  return { base, localRoot, projects };
}

test('1c: a localhost channel resolves by bare slug with no transport prefix', async () => {
  const { base, localRoot, projects } = makeLocalFixture();
  const prev = { r: process.env.COLLAB_REPOS_ROOT, l: process.env.COLLAB_LOCAL_ROOT };
  try {
    const route = await freshRoute(projects, localRoot);
    const state = route.buildStateFromDisk(TRIPLET);
    const r = route.detectAction(`look at slug ${LOCAL_SLUG}`, state);

    assert.notEqual(r.route, 'fuzzy', 'localhost channel was not found without an explicit prefix');
    assert.notEqual(r.route, 'kickoff', 'unresolved-looking lookup fell through to kickoff — forks a duplicate channel');
    assert.equal(r.slug, LOCAL_SLUG);
    // The transport must be the one the channel actually lives on, not the default.
    assert.equal(r.transport, 'localhost', `resolved to the wrong transport: ${r.transport}`);
  } finally {
    process.env.COLLAB_REPOS_ROOT = prev.r; process.env.COLLAB_LOCAL_ROOT = prev.l;
    rmSync(base, { recursive: true, force: true });
  }
});

test('1c: a localhost channel resolves by bare PIN with no transport prefix', async () => {
  const { base, localRoot, projects } = makeLocalFixture();
  const prev = { r: process.env.COLLAB_REPOS_ROOT, l: process.env.COLLAB_LOCAL_ROOT };
  try {
    const route = await freshRoute(projects, localRoot);
    const state = route.buildStateFromDisk(TRIPLET);
    const r = route.detectAction(LOCAL_PIN, state);

    assert.notEqual(r.route, 'fuzzy', 'localhost channel was not found by PIN without an explicit prefix');
    assert.notEqual(r.route, 'kickoff', 'PIN lookup fell through to kickoff — forks a duplicate channel');
    assert.equal(r.slug, LOCAL_SLUG);
    assert.equal(r.transport, 'localhost', `resolved to the wrong transport: ${r.transport}`);
  } finally {
    process.env.COLLAB_REPOS_ROOT = prev.r; process.env.COLLAB_LOCAL_ROOT = prev.l;
    rmSync(base, { recursive: true, force: true });
  }
});

test('1c: an explicit transport prefix still wins when the slug exists there', async () => {
  const { base, localRoot, projects } = makeLocalFixture();
  const prev = { r: process.env.COLLAB_REPOS_ROOT, l: process.env.COLLAB_LOCAL_ROOT };
  try {
    const route = await freshRoute(projects, localRoot);
    const state = route.buildStateFromDisk(TRIPLET);
    const r = route.detectAction(`look at slug ${LOCAL_SLUG}`, state, 'localhost');
    assert.equal(r.transport, 'localhost');
    assert.equal(r.slug, LOCAL_SLUG);
  } finally {
    process.env.COLLAB_REPOS_ROOT = prev.r; process.env.COLLAB_LOCAL_ROOT = prev.l;
    rmSync(base, { recursive: true, force: true });
  }
});
