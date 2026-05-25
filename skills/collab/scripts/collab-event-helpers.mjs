/**
 * collab-event-helpers.mjs — shared helpers for collab-plugin scripts.
 *
 * Owns: git transport, event I/O, triplet derivation, slug resolution.
 * All other scripts import from here. No git calls anywhere else.
 * Shell calls: spawnSync with array args only (no exec/execSync).
 */
import {
  readFileSync, writeFileSync, appendFileSync,
  existsSync, mkdirSync, readdirSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const FILES_REPO = resolve(homedir(), 'Documents/Projects/files');
export const COLLABS_DIR = join(FILES_REPO, 'collabs');
export const TICK_INTERVAL_MS = 30 * 60 * 1000; // default 30 min; per-collab override via kickoff payload's tick_interval_minutes
export const STALL_TICKS = 6;
export const MAX_OBJECTION_CYCLES = 3;
export const SILENCE_RATIFY_MS = 3 * TICK_INTERVAL_MS; // default 90 min — 3 ticks at 30-min cadence; scaled per-collab below

// --- Slug ---

export function deriveSlug(message) {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 50)
    .replace(/-+$/, '');
}

// --- Triplet ---

export function detectHarness() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude-code';
  if (process.env.CODEX_PLUGIN_ROOT) return 'codex';
  if (process.env.GEMINI_PLUGIN_ROOT) return 'gemini';
  return 'claude-code';
}

export function deriveTriplet(workspaceId) {
  const r = spawnSync('hostname', ['-s'], { encoding: 'utf8' });
  const machine = (r.stdout || '').trim() || 'unknown';
  return `${workspaceId}@${detectHarness()}:${machine}`;
}

export function authorSlugFromTriplet(triplet) {
  return triplet.split('@')[0];
}

// --- Collab directory ---

export function findCollabDir(slug) {
  if (!existsSync(COLLABS_DIR)) return null;
  for (const e of readdirSync(COLLABS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const slugPart = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    if (slugPart === slug) return join(COLLABS_DIR, e.name);
  }
  return null;
}

export function resolveCollabRef(ref) {
  const exact = findCollabDir(ref);
  if (exact) return { dir: exact, slug: ref };

  if (!existsSync(COLLABS_DIR)) return null;
  const candidates = [];
  for (const e of readdirSync(COLLABS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const slugPart = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    if (slugPart.startsWith(ref)) {
      const dir = join(COLLABS_DIR, e.name);
      if (!isClosed(readEvents(dir))) candidates.push({ dir, slug: slugPart });
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return { ambiguous: true, candidates };
  return null;
}

export function createCollabDir(slug) {
  if (!existsSync(COLLABS_DIR)) mkdirSync(COLLABS_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  let dirName = `${date}-${slug}`;
  let dir = join(COLLABS_DIR, dirName);
  let n = 2;
  while (existsSync(dir)) { dirName = `${date}-${slug}-${n}`; dir = join(COLLABS_DIR, dirName); n++; }
  mkdirSync(join(dir, 'turns'), { recursive: true });
  return dir;
}

// --- Event I/O ---

export function readEvents(collabDir) {
  const path = join(collabDir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

export function nextEventId(events) {
  if (events.length === 0) return 'evt-001';
  const last = events[events.length - 1].event_id;
  const n = parseInt(last.replace('evt-', ''), 10) + 1;
  const width = Math.max(3, String(n).length);
  return 'evt-' + String(n).padStart(width, '0');
}

export function appendEvent(collabDir, event) {
  appendFileSync(join(collabDir, 'events.jsonl'), JSON.stringify(event) + '\n');
}

// --- Event queries ---

export function getJoinedAgents(events) {
  const joined = new Set();
  const withdrawn = new Set();
  for (const e of events) {
    if (e.type === 'join') joined.add(e.author);
    if (e.type === 'withdraw') withdrawn.add(e.author);
  }
  return [...joined].filter(a => !withdrawn.has(a));
}

export function isClosed(events) { return events.some(e => e.type === 'close'); }
export function hasJoined(events, triplet) { return events.some(e => e.type === 'join' && e.author === triplet); }
export function hasDeclined(events, triplet) { return events.some(e => e.type === 'decline' && e.author === triplet); }

export function findActiveProposeClose(events) {
  let active = null;
  for (const e of events) {
    if (e.type === 'propose-close') active = e;
    if (e.type === 'object' || e.type === 'close') active = null;
  }
  return active;
}

// Per-collab tick cadence. Reads `tick_interval_minutes` from the kickoff event's
// payload; falls back to the default TICK_INTERVAL_MS (30 min). Kickoffs without
// the field keep v0.1.1 behavior; collabs that need faster iteration (e.g.
// localhost-pattern or rapid spec critique) opt in by declaring it at kickoff.
export function getTickIntervalMs(events) {
  const kickoff = events.find(e => e.type === 'kickoff');
  const minutes = kickoff?.payload?.tick_interval_minutes;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) {
    return TICK_INTERVAL_MS;
  }
  return minutes * 60 * 1000;
}

export function checkSafetyNets(events, nowTs) {
  const kickoff = events.find(e => e.type === 'kickoff');
  if (!kickoff) return null;
  const now = new Date(nowTs || new Date().toISOString());

  const wallClockHours = kickoff.payload.wall_clock_hours ?? 24;
  if (now - new Date(kickoff.ts) > wallClockHours * 3600000) return 'wall-clock';

  const tickMs = getTickIntervalMs(events);
  const lastEvent = events[events.length - 1];
  if (now - new Date(lastEvent.ts) > STALL_TICKS * tickMs) return 'stall';

  let cycles = 0, inPropose = false;
  for (const e of events) {
    if (e.type === 'propose-close') { inPropose = true; }
    if (e.type === 'object' && inPropose) { cycles++; inPropose = false; }
    if (e.type === 'ratify' || e.type === 'close') { inPropose = false; }
  }
  if (cycles >= MAX_OBJECTION_CYCLES) return 'objection-deadlock';
  return null;
}

export function getRatificationStatus(events, nowTs) {
  // Find the latest propose-close (not nullified by a subsequent object — that's
  // findActiveProposeClose's job; here we still want to report ratification state
  // so callers can see who objected and what state the propose-close ended in).
  // A subsequent 'close' event does nullify (collab is over).
  let proposeClose = null;
  for (const e of events) {
    if (e.type === 'propose-close') proposeClose = e;
    if (e.type === 'close') proposeClose = null;
  }
  if (!proposeClose) return null;
  const joined = getJoinedAgents(events);
  const others = joined.filter(a => a !== proposeClose.author);
  const proposeIdx = events.findIndex(e => e.event_id === proposeClose.event_id);
  const after = events.slice(proposeIdx + 1);
  const explicitRatified = new Set(after.filter(e => e.type === 'ratify').map(e => e.author));
  const objected = new Set(after.filter(e => e.type === 'object').map(e => e.author));

  // Silence-as-ratification: any agent who has emitted no events since propose-close
  // AND wall-clock has exceeded the silence-ratify window (3 ticks at this collab's
  // cadence) is treated as implicitly ratified.
  const now = new Date(nowTs || new Date().toISOString());
  const proposeTs = new Date(proposeClose.ts);
  const silenceElapsed = now - proposeTs;
  const silenceRatifyMs = 3 * getTickIntervalMs(events);
  const eligibleForSilenceRatify = silenceElapsed > silenceRatifyMs;

  const implicitRatified = new Set();
  if (eligibleForSilenceRatify) {
    for (const agent of others) {
      if (explicitRatified.has(agent) || objected.has(agent)) continue;
      // Has this agent emitted ANY event since propose-close?
      const agentEventsSince = after.some(e => e.author === agent);
      if (!agentEventsSince) implicitRatified.add(agent);
    }
  }

  const allRatified = new Set([...explicitRatified, ...implicitRatified]);
  const pending = others.filter(a => !allRatified.has(a) && !objected.has(a));
  return {
    proposeClose,
    otherAgents: others,
    ratified: [...allRatified],          // explicit + implicit combined
    explicitRatified: [...explicitRatified],
    implicitRatified: [...implicitRatified],
    objected: [...objected],
    pending,
    converged: pending.length === 0 && objected.size === 0,
  };
}

// --- Git transport ---

export function gitPullRebase() {
  const r = spawnSync('git', ['pull', '--rebase'], { cwd: FILES_REPO, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git pull --rebase failed: ${r.stderr}`);
}

export function gitCommitPush(collabDir, commitMsg) {
  spawnSync('git', ['add', collabDir], { cwd: FILES_REPO, encoding: 'utf8' });
  spawnSync('git', ['commit', '-m', commitMsg, '--allow-empty'], { cwd: FILES_REPO, encoding: 'utf8' });
  for (let i = 1; i <= 3; i++) {
    const push = spawnSync('git', ['push'], { cwd: FILES_REPO, encoding: 'utf8' });
    if (push.status === 0) return;
    spawnSync('git', ['pull', '--rebase'], { cwd: FILES_REPO, encoding: 'utf8' });
  }
  throw new Error('git push failed after 3 attempts');
}
