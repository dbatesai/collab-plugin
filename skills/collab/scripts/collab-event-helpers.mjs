/**
 * collab-event-helpers.mjs — shared helpers for collab-plugin scripts.
 *
 * Owns: git transport, event I/O, triplet derivation, slug resolution.
 * All other scripts import from here. No git calls anywhere else.
 * Shell calls: spawnSync with array args only (no exec/execSync).
 */
import {
  readFileSync, writeFileSync,
  existsSync, mkdirSync, readdirSync, renameSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// detectHarness lives in transport.mjs (v0.2 fallback chain: CODEX → GEMINI → COLLAB_HARNESS_OVERRIDE → 'claude-code').
// Imported here so deriveTriplet can call it; re-exported so existing call sites that import from helpers keep working.
import { detectHarness, LOCAL_COLLABS_ROOT, GITHUB_REPOS_ROOT } from './transport.mjs';
export { detectHarness };

export const FILES_REPO = resolve(homedir(), 'Documents/Projects/files');
export const COLLABS_DIR = join(FILES_REPO, 'collabs');
export const TICK_INTERVAL_MS = 30 * 60 * 1000; // default 30 min; per-collab override via kickoff payload's tick_interval_minutes
export const STALL_TICKS = 6;
export const MAX_OBJECTION_CYCLES = 3;
export const SILENCE_RATIFY_MS = 3 * TICK_INTERVAL_MS; // default 90 min — 3 ticks at 30-min cadence; scaled per-collab below

// --- PIN ---

// 6-digit shorthand id for a collab. Stored on the kickoff event's payload as
// `pin`; not part of the slug or directory name. Lets a user (or peer) refer to
// a collab as "/collab 654321" instead of typing the full semantic slug. With
// ~10 active collabs ever and 1M possible values, collision risk is negligible;
// the date in the dir name and event timestamps disambiguate further if needed.
export function generatePin() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}

export function isPinRef(ref) {
  return typeof ref === 'string' && /^\d{6}$/.test(ref);
}

// Resolve a 6-digit PIN to a collab dir by scanning all collabs' evt-001
// kickoff events. Returns null if no match, or { dir, slug, pin } on hit.
// Prefers active collabs over closed ones; if there's still ambiguity (same
// pin on multiple active collabs — vanishingly rare), returns { ambiguous: true, candidates }.
export function resolveCollabByPin(pin) {
  if (!isPinRef(pin)) return null;
  if (!existsSync(COLLABS_DIR)) return null;
  const active = [], closed = [];
  for (const e of readdirSync(COLLABS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = join(COLLABS_DIR, e.name);
    const events = readEvents(dir);
    const kickoff = events.find(ev => ev.type === 'kickoff');
    if (!kickoff || kickoff.payload?.pin !== pin) continue;
    const slug = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const hit = { dir, slug, pin };
    if (isClosed(events)) closed.push(hit); else active.push(hit);
  }
  if (active.length === 1) return active[0];
  if (active.length > 1) return { ambiguous: true, candidates: active };
  if (closed.length === 1) return closed[0];
  if (closed.length > 1) return { ambiguous: true, candidates: closed };
  return null;
}

// --- Slug ---

export function deriveSlug(message) {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  if (slug.length <= 50) return slug;
  // Truncate at a word boundary (last hyphen at or before 50 chars)
  const truncated = slug.slice(0, 50);
  const lastHyphen = truncated.lastIndexOf('-');
  return lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
}

// --- Event ID ---

// Sortable unique event ID: evt-<YYYYMMDDHHmm>-<author-slug>-<4-hex-random>.
// Lexicographic sort on filename = chronological order (no central counter).
export function generateEventId(tsIso, authorSlug) {
  const d = new Date(tsIso);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  const rand = randomBytes(2).toString('hex');
  return `evt-${stamp}-${authorSlug}-${rand}`;
}

// --- Triplet ---

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

// Scan all known transport roots for a slug. Returns
// { transport, dir, dirName } on first hit, or null if absent everywhere.
//
// Transports searched:
//   - localhost (LOCAL_COLLABS_ROOT)
//   - every github:<repo> discovered by listing GITHUB_REPOS_ROOT for a collabs/ subdirectory
export function findCollabAcrossTransports(slug) {
  const roots = [];
  if (existsSync(LOCAL_COLLABS_ROOT)) roots.push({ transport: 'localhost', root: LOCAL_COLLABS_ROOT });
  if (existsSync(GITHUB_REPOS_ROOT)) {
    for (const e of readdirSync(GITHUB_REPOS_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const candidate = join(GITHUB_REPOS_ROOT, e.name, 'collabs');
      if (existsSync(candidate)) roots.push({ transport: `github:${e.name}`, root: candidate });
    }
  }
  for (const { transport, root } of roots) {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const slugPart = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      if (slugPart === slug) return { transport, dir: join(root, e.name), dirName: e.name };
    }
  }
  return null;
}

// Throw when slug exists in any transport. Used by collab-kickoff.mjs (§6.3 strict).
export function assertSlugUnique(slug) {
  const hit = findCollabAcrossTransports(slug);
  if (hit) {
    throw new Error(`A collab named "${slug}" already exists in transport "${hit.transport}" (dir: ${hit.dirName}). Rephrase the kickoff message to derive a different slug.`);
  }
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

// Read all events from <collabDir>/events/*.json. Sort by ts, then event_id as tie-breaker.
// Backward compat: if events/ does not exist but events.jsonl does, read JSONL directly (v0.1.x).
export function readEvents(collabDir) {
  const eventsDir = join(collabDir, 'events');
  if (existsSync(eventsDir)) {
    const seen = new Map(); // event_id → event (first wins on dup)
    for (const name of readdirSync(eventsDir)) {
      if (!name.endsWith('.json') || name.startsWith('.tmp-')) continue;
      const path = join(eventsDir, name);
      try {
        const content = readFileSync(path, 'utf8');
        const event = JSON.parse(content);
        if (!event || typeof event !== 'object' || !event.event_id || !event.ts) {
          process.stderr.write(`(warn) skipping malformed event file ${path}\n`);
          continue;
        }
        if (!seen.has(event.event_id)) seen.set(event.event_id, event);
      } catch (e) {
        process.stderr.write(`(warn) skipping unreadable event file ${path}: ${e.message}\n`);
      }
    }
    return [...seen.values()].sort((a, b) => {
      if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
      return a.event_id < b.event_id ? -1 : 1;
    });
  }
  const jsonlPath = join(collabDir, 'events.jsonl');
  if (!existsSync(jsonlPath)) return [];
  const out = [];
  for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); }
    catch (e) { process.stderr.write(`(warn) skipping malformed JSONL line in ${jsonlPath}: ${e.message}\n`); }
  }
  return out;
}

// Atomic write: temp file + rename. Always writes to events/ dir.
//
// v0.1.x hybrid guard: if this collab dir has events.jsonl but no events/, refuse
// to write. The first append would otherwise strand all prior JSONL events behind
// the new events/ directory (which readEvents prefers when present). Surfacing
// the conflict loudly is the right move per spec §9.6 (read-only compat).
export function appendEvent(collabDir, event) {
  const eventsDir = join(collabDir, 'events');
  const jsonlPath = join(collabDir, 'events.jsonl');
  if (!existsSync(eventsDir) && existsSync(jsonlPath)) {
    throw new Error(
      `Refusing to write to v0.1.x collab at ${collabDir}: events.jsonl present but no events/ directory. ` +
      `v0.2 cannot safely append to v0.1.x collabs because the first append would strand the existing history. ` +
      `Either run this collab on a fresh slug or migrate the JSONL forward (manual: read events.jsonl, write each line as events/<event_id>.json).`,
    );
  }
  if (!existsSync(eventsDir)) mkdirSync(eventsDir, { recursive: true });
  const finalPath = join(eventsDir, `${event.event_id}.json`);
  const tmpPath = join(eventsDir, `.tmp-${event.event_id}-${process.pid}-${Date.now()}-${randomBytes(2).toString('hex')}.json`);
  writeFileSync(tmpPath, JSON.stringify(event, null, 2));
  renameSync(tmpPath, finalPath);
}

// Regenerate events.jsonl from events/ dir (render artifact, not source of truth).
export function renderEventsJsonl(collabDir) {
  const events = readEvents(collabDir);
  const content = events.map(e => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
  writeFileSync(join(collabDir, 'events.jsonl'), content);
}

// nextEventId: legacy helper for v0.1.x sequential IDs (still produced by kickoff for
// evt-001 display). v0.2 uses generateEventId for everything else.
export function nextEventId(events) {
  if (events.length === 0) return 'evt-001';
  const seq = events.filter(e => /^evt-\d{3,}$/.test(e.event_id));
  if (seq.length === 0) return generateEventId(new Date().toISOString(), 'sys');
  const last = seq[seq.length - 1].event_id;
  const n = parseInt(last.replace('evt-', ''), 10) + 1;
  const width = Math.max(3, String(n).length);
  return 'evt-' + String(n).padStart(width, '0');
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
