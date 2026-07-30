/**
 * collab-event-helpers.mjs — shared helpers for collab-plugin scripts.
 *
 * Owns: git transport, event I/O, triplet derivation, slug resolution.
 * All other scripts import from here. No git calls anywhere else.
 * Shell calls: spawnSync with array args only (no exec/execSync).
 */
import {
  readFileSync, writeFileSync,
  existsSync, mkdirSync, readdirSync, linkSync, unlinkSync, statSync,
} from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// detectHarness lives in transport.mjs (v0.2 fallback chain: CODEX → GEMINI → COLLAB_HARNESS_OVERRIDE → 'claude-code').
// Imported here so deriveTriplet can call it; re-exported so existing call sites that import from helpers keep working.
import {
  detectHarness, localCollabsRoot, githubReposRoot,
  parseTransport, collabsRootForTransport,
} from './transport.mjs';
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

// Sortable unique event ID: evt-<YYYYMMDDHHmm>-<author-slug>-<uuidv4>.
// Lexicographic sort on event_id is NOT relied on for ordering — readEvents sorts
// by `ts` then event_id (v1.0 invariant). The suffix exists only for uniqueness.
//
// The author component is PERSISTED, so concurrent processes and restarts share it. The
// random component therefore carries the whole collision burden and must be UUID-grade; a
// short nonce plus a per-process counter does not, because each process restarts its
// sequence at zero.
export function generateEventId(tsIso, authorSlug) {
  const d = new Date(tsIso);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `evt-${stamp}-${authorSlug}-${randomUUID()}`;
}

// --- Triplet ---

export function deriveTriplet(workspaceId) {
  // `hostname -s` is unsupported on Windows; fall back to no-args form which
  // works cross-platform and returns the short hostname on all three OSes.
  let r = spawnSync('hostname', ['-s'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) r = spawnSync('hostname', [], { encoding: 'utf8' });
  const machine = (r.stdout || '').trim().split('.')[0] || 'unknown';
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
  const LOCAL_ROOT = localCollabsRoot();
  const REPOS_ROOT = githubReposRoot();
  if (existsSync(LOCAL_ROOT)) roots.push({ transport: 'localhost', root: LOCAL_ROOT });
  if (existsSync(REPOS_ROOT)) {
    for (const e of readdirSync(REPOS_ROOT, { withFileTypes: true })) {
      const candidate = join(REPOS_ROOT, e.name, 'collabs');
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
      // Skip non-JSON and dot-prefixed artifacts: .tmp- (in-flight writes),
      // .quarantined- (v1 invalid events), .superseded- (quarantine originals).
      // Any dotfile is a non-routing artifact beside the event store.
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
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
  const body = JSON.stringify(event, null, 2);
  writeFileSync(tmpPath, body);

  // Exclusive create. rename() is atomic but replaces an existing destination silently, so
  // a same-id conflict would overwrite a committed event; link() fails EEXIST instead. The
  // temp write stays because O_CREAT|O_EXCL alone leaves a window where a reader sees a
  // partial file.
  try {
    linkSync(tmpPath, finalPath);
    unlinkSync(tmpPath);            // link made a second name for the same inode
    return { written: true, idempotent: false };
  } catch (e) {
    if (e.code !== 'EEXIST') { try { unlinkSync(tmpPath); } catch { /* best effort */ } throw e; }

    // The id already exists. Identical bytes means this is a retry — the recovery ladder
    // re-appends after a transport failure, and erroring there would break recovery.
    let existing = null;
    try { existing = readFileSync(finalPath, 'utf8'); } catch { /* unreadable; treat as conflict */ }
    try { unlinkSync(tmpPath); } catch { /* best effort */ }

    if (existing === body) return { written: false, idempotent: true };

    const err = new Error(
      `event id conflict: ${event.event_id} already exists in ${eventsDir} with different content. ` +
      `The committed event was NOT replaced. Emit this event under a fresh id, and record the conflict.`,
    );
    err.code = 'EEVENTCONFLICT';
    throw err;
  }
}

// --- Foreign-surface detection and reconcile ---
//
// events.jsonl is a render, not an authority — but a legacy v0.1.x writer appends only
// there, so its events exist nowhere else. Rendering rebuilds that file from events/, so
// foreign events must be imported first or they are destroyed with no error.

/**
 * Split events.jsonl into events absent from canonical (`foreign`) and lines that cannot
 * be parsed into an event at all (`malformed`).
 */
export function foreignSurfaceEvents(collabDir) {
  const eventsDir = join(collabDir, 'events');
  const jsonlPath = join(collabDir, 'events.jsonl');
  if (!existsSync(eventsDir) || !existsSync(jsonlPath)) return { foreign: [], malformed: [] };

  const canonical = new Set(
    readdirSync(eventsDir)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .map(f => f.slice(0, -'.json'.length)),
  );

  const foreign = [], malformed = [];
  const lines = readFileSync(jsonlPath, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); }
    catch (err) { malformed.push({ line: i + 1, reason: `unparseable JSON: ${err.message}` }); continue; }
    if (!e || typeof e !== 'object' || !e.event_id || !e.ts) {
      malformed.push({ line: i + 1, reason: 'missing event_id or ts' });
      continue;
    }
    if (canonical.has(e.event_id)) continue;
    foreign.push(e);
  }
  return { foreign, malformed };
}

/**
 * Import foreign events into canonical. Returns { imported, escalated }.
 *
 * Runs without human input: recovery that stops to ask is just a slower stop. Import
 * requires the event to be parseable, to belong to this channel, and to be non-conflicting.
 * Anything else escalates, and a rejected event never halts the valid events beside it.
 */
export function reconcileForeignSurface(collabDir, author) {
  const { foreign, malformed } = foreignSurfaceEvents(collabDir);
  const imported = [], escalated = [];

  for (const m of malformed) {
    escalated.push({ event_id: null, line: m.line, reason: m.reason });
  }
  if (foreign.length === 0) return { imported, escalated };

  // Channel identity comes from the canonical kickoff, never from the foreign event.
  const canonicalEvents = readEvents(collabDir);
  const slug = canonicalEvents.find(e => e.type === 'kickoff')?.slug
    ?? canonicalEvents[0]?.slug ?? null;

  // Authorized source: membership is a fact established by canonical kickoff/join events,
  // never inferred from the event's own author field. Without this, anything able to append
  // to events.jsonl can forge a turn under any identity and have it become canonical.
  //
  // This is AUTHORIZATION, not authentication. A writer with filesystem access can still
  // spoof a joined triplet; what this establishes is that the claimed identity was a member
  // of this channel at the event's position — not that the writer is who they say.
  //
  // Evaluated causally: "ever joined" would admit an event authored before its author
  // joined, and one authored after they withdrew. Identity is compared exactly — a triplet
  // differing by punctuation is a different identity, repaired by an explicit rejoin, never
  // by normalizing the string.
  const membership = canonicalEvents
    .filter(e => e.type === 'kickoff' || e.type === 'join' || e.type === 'withdraw')
    .map(e => ({ author: e.author, ts: e.ts, joins: e.type !== 'withdraw' }));

  const authorizedAt = (author, ts) => {
    let member = false;
    for (const m of membership) {
      if (m.author !== author || m.ts > ts) continue;
      member = m.joins;                       // last transition at or before ts wins
    }
    return member;
  };

  for (const e of foreign) {
    if (slug && e.slug !== slug) {
      escalated.push({ event_id: e.event_id, reason: `channel mismatch: event slug "${e.slug}" != "${slug}"` });
      continue;
    }
    if (!authorizedAt(e.author, e.ts)) {
      escalated.push({
        event_id: e.event_id,
        reason: `unauthorized author at event position: "${e.author}" had no active canonical ` +
                `kickoff/join at or before ${e.ts} (or had withdrawn). An identity that differs ` +
                'even by punctuation is a different member; repair with an explicit rejoin.',
      });
      continue;
    }
    try {
      appendEvent(collabDir, e);
      imported.push(e.event_id);
    } catch (err) {
      escalated.push({
        event_id: e.event_id,
        reason: err.code === 'EEVENTCONFLICT' ? 'id already exists with different content' : err.message,
      });
    }
  }

  // The heal must be observable. A silent repair is indistinguishable from a bug.
  if (imported.length > 0 && author) {
    const ts = new Date().toISOString();
    appendEvent(collabDir, {
      event_id: generateEventId(ts, authorSlugFromTriplet(author)),
      ts, author, slug: slug ?? '', type: 'reconciled', references: imported,
      payload: {
        imported, escalated,
        source_surface: 'events.jsonl',
        note: 'Imported events written by a legacy JSONL-only writer that canonical did not hold.',
      },
    });
  }
  return { imported, escalated };
}

// Regenerate events.jsonl from events/ (render artifact, not source of truth).
//
// Refuses when events.jsonl holds events canonical does not, since rendering would destroy
// them. The guard is at the writer boundary so every caller inherits it; reconcile first.
export function renderEventsJsonl(collabDir) {
  const { foreign } = foreignSurfaceEvents(collabDir);
  if (foreign.length > 0) {
    const err = new Error(
      `Refusing to render events.jsonl in ${collabDir}: ${foreign.length} unreconciled foreign ` +
      `event(s) present that canonical does not hold (${foreign.map(e => e.event_id).join(', ')}). ` +
      `Rendering would destroy them. Run reconcileForeignSurface() first.`,
    );
    err.code = 'EUNRECONCILEDFOREIGN';
    err.foreignIds = foreign.map(e => e.event_id);
    throw err;
  }
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

// --- Obligations: leases, chase, and executed timeout actions ---
//
// Chase alone is not escalation. A scanner that emits three chases and then goes quiet is a
// silent stall: the ledger shows activity while nothing advances, and the only thing that
// moves the goal is a human noticing. So an exhausted chase sequence hands off to the
// DECLARED on_timeout action, and that action executes and leaves a record.

export const OBLIGATION_GRACE_MS = 5 * 60 * 1000;
export const CHASE_FLOOD_LIMIT = 3;
export const NO_PROGRESS_WINDOW_MS = 10 * 60 * 1000;
export const VALID_TIMEOUT_ACTIONS = ['proceed-alone', 'reassign', 'degrade-and-continue', 'close-degraded'];

const ISO_RE_OBL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const isChase = (e) => e.type === 'turn' && (e.payload?.intent === 'chase' || (e.payload?.signals || []).includes('chase'));

// Bookkeeping the system emits about itself. None of it advances the goal, so none of it
// counts as progress.
const isSubstantive = (e) => {
  if (['chase', 'quarantined', 'reconciled', 'timeout-action'].includes(e.type)) return false;
  if (isChase(e)) return false;
  if (e.type === 'turn') return Boolean((e.payload?.body || '').trim());
  return ['propose-close', 'ratify', 'object', 'close', 'join', 'kickoff'].includes(e.type);
};

/**
 * What is owed right now. Pure: takes events, returns findings. The scanner decides, not
 * in-the-moment judgment, because an agent deep in a long session will just keep waiting.
 */
export function evaluateObligations(events, { now, self }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const due = [], invalid = [];

  const latestPerAuthor = new Map();
  for (const e of events) {
    if (e.type !== 'turn' || e.author === self) continue;
    if (!e.payload?.next_update_by) continue;
    latestPerAuthor.set(e.author, e);
  }

  for (const [participant, e] of latestPerAuthor) {
    const dl = e.payload.next_update_by;
    if (!ISO_RE_OBL.test(dl)) continue;             // non-ISO deadlines are unreliable; skip

    // A wait with a deadline but no declared action is an unbounded wait.
    if (!VALID_TIMEOUT_ACTIONS.includes(e.payload.on_timeout)) {
      invalid.push({
        event_id: e.event_id, participant,
        reason: `waiting with a deadline but no valid on_timeout (got ${JSON.stringify(e.payload.on_timeout)}); ` +
                `expected one of ${VALID_TIMEOUT_ACTIONS.join(', ')}`,
      });
      continue;
    }
    if (nowMs - Date.parse(dl) < OBLIGATION_GRACE_MS) continue;

    // Already discharged? Do not re-fire policy forever.
    const settled = events.some(x => x.type === 'timeout-action' && x.payload?.participant === participant
      && Date.parse(x.payload?.for_deadline || 0) === Date.parse(dl));
    if (settled) continue;

    const chases = events.filter(x => isChase(x) && Date.parse(x.ts) > Date.parse(dl)).length;
    due.push(chases < CHASE_FLOOD_LIMIT
      ? { participant, action: 'chase', for_deadline: dl, chases_so_far: chases }
      : { participant, action: e.payload.on_timeout, for_deadline: dl, chases_so_far: chases });
  }

  // Zero-progress escalation: a window containing only bookkeeping means the collaboration
  // looks busy and is not moving.
  let escalate = null;
  const inWindow = events.filter(e => nowMs - Date.parse(e.ts) <= NO_PROGRESS_WINDOW_MS);
  if (inWindow.length > 0 && !inWindow.some(isSubstantive)) {
    escalate = {
      reason: `no substantive progress in ${Math.round(NO_PROGRESS_WINDOW_MS / 60000)} minutes ` +
              `(${inWindow.length} bookkeeping event(s), 0 substantive) — chases are not progress`,
      window_events: inWindow.length,
    };
  }
  return { due, invalid, escalate };
}

/** Execute a due timeout action and leave a routed record. Reporting it is not enough. */
export function executeTimeoutAction(collabDir, item, author) {
  if (!item || !VALID_TIMEOUT_ACTIONS.includes(item.action)) return null;
  const ts = new Date().toISOString();
  const ev = {
    event_id: generateEventId(ts, authorSlugFromTriplet(author)),
    ts, author, slug: readEvents(collabDir).find(e => e.type === 'kickoff')?.slug ?? '',
    type: 'timeout-action', references: [],
    payload: {
      schema_version: '1.0',
      provenance: { emit_mode: 'automated', harness: 'obligation-scanner' },
      action: item.action, participant: item.participant, for_deadline: item.for_deadline,
      chases_so_far: item.chases_so_far,
      note: 'Declared on_timeout policy executed after the chase sequence was exhausted. '
          + 'The wait is now closed by policy rather than left open indefinitely.',
      signals: ['timeout-executed', item.action],
    },
  };
  appendEvent(collabDir, ev);
  return ev;
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

// Per-collab ratification window. Reads `ratification_window_minutes` from the
// kickoff event's payload (v0.2). Falls back to 3 × tick_interval (v0.1.x behavior)
// when the new field is absent.
export function getRatificationWindowMs(events) {
  const kickoff = events.find(e => e.type === 'kickoff');
  const minutes = kickoff?.payload?.ratification_window_minutes;
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    return minutes * 60 * 1000;
  }
  return 3 * getTickIntervalMs(events);
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
  const silenceRatifyMs = getRatificationWindowMs(events);
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

// --- Version check ---

function parseSemver(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmpSemver(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

// Compare local installed version against minimum required. Returns {ok, error?}.
// When minRequired is undefined/null/empty, the check passes (v0.1.x compat).
// Accepts localVersion as either a plain string ('0.2.0') OR a metadata object
// ({ version, source, confidence }) per v1.0 plan §8 — preserves legacy callers.
export function checkMinVersion(localVersion, minRequired) {
  if (!minRequired) return { ok: true };
  const localStr = (localVersion && typeof localVersion === 'object')
    ? localVersion.version : localVersion;
  const local = parseSemver(localStr);
  const min = parseSemver(minRequired);
  if (!local || !min) return { ok: false, error: `version parse error (local=${localStr}, min=${minRequired})` };
  if (cmpSemver(local, min) >= 0) return { ok: true };
  return { ok: false, error: `This collab requires collab-plugin >= ${minRequired}; this install is on ${localStr}. Upgrade and retry.` };
}

// Read the plugin version from <plugin-root>/<harness-manifest>/plugin.json.
// Walks the same env var chain as detectHarness() so Codex/Gemini agents resolve correctly.
// CI enforces lockstep across all three manifests, so whichever resolves yields the same version.
//
// Fallback chain (in order):
// 1. Env var roots (CODEX_PLUGIN_ROOT, GEMINI_PLUGIN_ROOT, CLAUDE_PLUGIN_ROOT, COLLAB_PLUGIN_ROOT)
// 2. Path-based: extract version from install cache path when env vars absent (Bash tool context)
//    e.g., ~/.claude/plugins/cache/collab/collab/0.2.0/skills/collab/scripts/...
// 3. Default '0.0.0' — version check fails loudly.
export function readLocalPluginVersion() {
  // Legacy string-returning surface — preserved for v0.2 callers and tests.
  return readLocalPluginVersionInfo().version;
}

// v1.0 plan §8: version detection with provenance metadata.
// Returns { version, source, confidence }:
//   source: 'env-var:<NAME>' | 'cache-path' | 'fallback'
//   confidence: 'high' (manifest via env) | 'medium' (cache-path regex) | 'none'
export function readLocalPluginVersionInfo() {
  const candidates = [
    { env: 'CODEX_PLUGIN_ROOT',  manifest: '.codex-plugin/plugin.json'  },
    { env: 'GEMINI_PLUGIN_ROOT', manifest: '.gemini-plugin/plugin.json' },
    { env: 'CLAUDE_PLUGIN_ROOT', manifest: '.claude-plugin/plugin.json' },
    { env: 'COLLAB_PLUGIN_ROOT', manifest: '.claude-plugin/plugin.json' },
  ];
  for (const { env, manifest } of candidates) {
    const root = process.env[env];
    if (!root) continue;
    try {
      const pkg = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
      if (pkg.version) return { version: pkg.version, source: `env-var:${env}`, confidence: 'high' };
    } catch {
      // try the next candidate
    }
  }
  // Fallback: extract version from the script's own install cache path.
  // Handles the case where env vars are not injected (e.g., agent Bash tool calls).
  // Pattern: /.../plugins/cache/<scope>/<name>/<version>/...
  // Normalize to forward slashes first so the regex works on Windows paths too.
  try {
    const selfPath = fileURLToPath(import.meta.url).replace(/\\/g, '/');
    const match = selfPath.match(/\/plugins\/cache\/[^/]+\/[^/]+\/(\d+\.\d+\.\d+)\//);
    if (match) return { version: match[1], source: 'cache-path', confidence: 'medium' };
  } catch {
    // import.meta.url unavailable (CommonJS context); skip
  }
  return { version: '0.0.0', source: 'fallback', confidence: 'none' };
}

// --- Git transport ---

// repoForTransport: parent of the collabs/ dir for a github:<repo> transport.
// Throws if called on a non-git transport (localhost) — callers must guard with isGitTransport.
function repoForTransport(transport) {
  const p = parseTransport(transport);
  if (!p || p.kind !== 'github') {
    throw new Error(`git helpers require a github transport; got ${transport}`);
  }
  return dirname(collabsRootForTransport(transport));
}

// --- Repo operation claim ---
//
// Several agents can share one working copy, and git's own shared mutable state (notably
// .git/FETCH_HEAD) is not safe against concurrent operations: a concurrent fetch leaves
// multiple branch entries and `git pull --rebase` then refuses outright. Serializing repo
// operations behind an exclusive claim removes the race; the lease means a crashed holder
// cannot wedge the repo, and the generation means a resurrected holder cannot release
// someone else's claim.
export const REPO_CLAIM_TTL_MS = 60_000;
const REPO_CLAIM_MAX_ATTEMPTS = 6;

// A lease only prevents concurrency if the work it guards cannot outlive it. Unbounded
// network git calls under a timed lease is a lease that expires mid-operation: a second
// agent reclaims while the first is still mutating the repo. Worst-case guarded work must
// stay strictly under REPO_CLAIM_TTL_MS — asserted by the WP4 attack tests.
export const GIT_OP_TIMEOUT_MS = 6_000;
// Worst case is gitCommitPush: add(1) + commit(1) + 3x(push, pull)(6) = 8. The third
// iteration's pull still runs before the loop throws, so it counts.
export const GIT_MAX_OPS_PER_CLAIM = 8;

function repoClaimPath(repo) { return join(repo, '.git', 'collab-repo-claim.json'); }

/** Take the claim, or return null if another live owner holds it. */
export function acquireRepoClaim(repo, owner, now = Date.now()) {
  const claimPath = repoClaimPath(repo);
  let generation = 1;

  if (existsSync(claimPath)) {
    let held = null;
    try { held = JSON.parse(readFileSync(claimPath, 'utf8')); } catch { /* corrupt → reclaimable */ }
    const age = now - statSync(claimPath).mtimeMs;
    if (age < REPO_CLAIM_TTL_MS) return null;      // live owner
    generation = (held?.generation ?? 0) + 1;       // expired lease → reclaim
    try { unlinkSync(claimPath); } catch { /* raced; the link below decides */ }
  }

  const claim = { owner, generation, acquired_at: new Date(now).toISOString(), pid: process.pid };
  const tmp = join(repo, '.git', `.tmp-claim-${process.pid}-${now}.json`);
  writeFileSync(tmp, JSON.stringify(claim, null, 2));
  try {
    linkSync(tmp, claimPath);                       // exclusive: EEXIST if another won
    return claim;
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/** Release only if this claim is still the one on disk. */
export function releaseRepoClaim(repo, claim) {
  const claimPath = repoClaimPath(repo);
  if (!claim || !existsSync(claimPath)) return false;
  try {
    const held = JSON.parse(readFileSync(claimPath, 'utf8'));
    if (held.owner !== claim.owner || held.generation !== claim.generation) return false;
  } catch { return false; }
  try { unlinkSync(claimPath); return true; } catch { return false; }
}

/** Run fn while holding the claim. Retries with bounded jitter; always releases. */
export function withRepoClaim(repo, owner, fn) {
  let claim = null;
  for (let i = 0; i < REPO_CLAIM_MAX_ATTEMPTS && !claim; i++) {
    claim = acquireRepoClaim(repo, owner);
    if (!claim) {
      const backoff = 50 * (i + 1) + Math.floor(Math.random() * 100);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoff);
    }
  }
  if (!claim) {
    const err = new Error(
      `repo claim unavailable in ${repo} after ${REPO_CLAIM_MAX_ATTEMPTS} attempts — another agent ` +
      'is holding it. This is a degraded transport state, not an empty result.',
    );
    err.code = 'EREPOCLAIMBUSY';
    throw err;
  }
  try { return fn(); }
  finally { releaseRepoClaim(repo, claim); }
}

export function gitPullRebase(transport, owner = `pid-${process.pid}`) {
  const repo = repoForTransport(transport);
  // Throws rather than returning empty: a caller that swallows this reports a quiet
  // channel, which is indistinguishable from no peer activity.
  return withRepoClaim(repo, owner, () => { runGit(repo, ['pull', '--rebase']); });
}

// Every git call goes through here. An unchecked spawnSync discards status, signal and
// timeout, so a failed add or commit followed by a push that exits 0 reports success while
// the event was never committed.
function runGit(repo, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', timeout: GIT_OP_TIMEOUT_MS });
  const ok = !r.error && r.status === 0;
  if (!ok && !allowFail) {
    const why = r.error ? (r.error.code === 'ETIMEDOUT' ? `timed out after ${GIT_OP_TIMEOUT_MS}ms` : r.error.message)
                        : `exit ${r.status}: ${(r.stderr || '').trim()}`;
    const err = new Error(`git ${args[0]} failed in ${repo}: ${why}`);
    err.code = 'EGITOP';
    throw err;
  }
  return { ok, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function gitCommitPush(collabDir, transport, commitMsg, owner = `pid-${process.pid}`) {
  const repo = repoForTransport(transport);
  // Serialized with pull: add/commit/push and the rebase inside the retry all mutate the
  // same working copy and shared refs, so a concurrent agent mid-sequence is the race.
  return withRepoClaim(repo, owner, () => {
    runGit(repo, ['add', collabDir]);
    runGit(repo, ['commit', '-m', commitMsg, '--allow-empty']);
    for (let i = 1; i <= 3; i++) {
      // Push may legitimately fail (peer landed first); the rebase that follows may not.
      if (runGit(repo, ['push'], { allowFail: true }).ok) return;
      runGit(repo, ['pull', '--rebase']);
    }
    throw new Error(`git push failed after 3 attempts in ${repo}`);
  });
}
