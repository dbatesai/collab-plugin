/**
 * transport.mjs — Transport registry and helpers (v0.2).
 *
 * A transport is the channel a collab runs over. v0.2 ships two:
 *   localhost          → same-filesystem; events at ~/.collab/local/<date>-<slug>/
 *   github:<repo>      → git-mediated via ~/Documents/Projects/<repo>/collabs/<date>-<slug>/
 *
 * No other module hardcodes storage paths. Use this module's helpers exclusively.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync, accessSync, constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';

// Roots are env-overridable so tests can point the resolver at a temp fixture.
// Without the override the values are unchanged, so production behavior is identical.
export const LOCAL_COLLABS_ROOT = resolve(process.env.COLLAB_LOCAL_ROOT || join(homedir(), '.collab/local'));
export const GITHUB_REPOS_ROOT  = resolve(process.env.COLLAB_REPOS_ROOT || join(homedir(), 'Documents/Projects'));

const TRANSPORT_RE = /^(localhost|github:[a-z0-9_-]+)$/;
const GITHUB_REPO_RE = /^github:([a-z0-9_-]+)$/;

export function parseTransport(s) {
  if (typeof s !== 'string' || !TRANSPORT_RE.test(s)) return null;
  if (s === 'localhost') return { kind: 'localhost', repo: null };
  const m = s.match(GITHUB_REPO_RE);
  return { kind: 'github', repo: m[1] };
}

export function isGitTransport(transport) {
  const p = parseTransport(transport);
  return p?.kind === 'github';
}

export function defaultTickIntervalMinutes(transport) {
  const p = parseTransport(transport);
  if (p?.kind === 'localhost') return 2;
  return 30;
}

export function defaultRatificationWindowMinutes(transport, tickIntervalMinutes) {
  const tick = (typeof tickIntervalMinutes === 'number' && tickIntervalMinutes > 0) ? tickIntervalMinutes : 30;
  const base = 3 * tick;
  if (isGitTransport(transport)) return base;
  return Math.max(base, 30); // localhost floor
}

export function resolveTransportPaths(transport, dirName) {
  const p = parseTransport(transport);
  if (!p) throw new Error(`unknown transport: ${transport}`);
  let collabDir;
  if (p.kind === 'localhost') {
    collabDir = join(LOCAL_COLLABS_ROOT, dirName);
  } else {
    collabDir = join(GITHUB_REPOS_ROOT, p.repo, 'collabs', dirName);
  }
  return { collabDir, eventsDir: join(collabDir, 'events'), turnsDir: join(collabDir, 'turns') };
}

export function collabsRootForTransport(transport) {
  const p = parseTransport(transport);
  if (!p) throw new Error(`unknown transport: ${transport}`);
  if (p.kind === 'localhost') return LOCAL_COLLABS_ROOT;
  return join(GITHUB_REPOS_ROOT, p.repo, 'collabs');
}

function _preflight(rootDir) {
  try {
    if (!existsSync(rootDir)) mkdirSync(rootDir, { recursive: true });
    accessSync(rootDir, constants.R_OK | constants.W_OK);
    const probe = join(rootDir, `.preflight-${process.pid}-${Date.now()}`);
    writeFileSync(probe, '');
    unlinkSync(probe);
    return { ok: true, path: rootDir };
  } catch (e) {
    return { ok: false, path: rootDir, error: `preflight failed for ${rootDir}: ${e.message}` };
  }
}

export function preflightTransport(transport) {
  return _preflight(collabsRootForTransport(transport));
}

preflightTransport.__withRoot = (root) => _preflight(root);

// detectHarness v0.2 fallback chain. CODEX > GEMINI > COLLAB_HARNESS_OVERRIDE > 'claude-code'.
// Re-exported from collab-event-helpers.mjs so deriveTriplet routes through the same chain
// (including the COLLAB_HARNESS_OVERRIDE escape hatch — Finding #15 fix).
export function detectHarness() {
  if (process.env.CODEX_PLUGIN_ROOT)  return 'codex';
  if (process.env.GEMINI_PLUGIN_ROOT) return 'gemini';
  if (process.env.COLLAB_HARNESS_OVERRIDE) return process.env.COLLAB_HARNESS_OVERRIDE;
  return 'claude-code';
}
