/**
 * collab-cadence.mjs — dynamic cadence state management for collab-plugin v1.0.
 *
 * Manages the polling interval ladder for a participant in a collab:
 *   - fast-poll (30s): after posting or receiving an event
 *   - base (5min): default, when no recent activity
 *   - idle (15min): when no events from any participant for >30min
 *
 * Cadence is coordinated through `next_update_by` in event payloads.
 * This module reads/writes cursor state to a per-participant file.
 *
 * Cursor file path:
 *   ~/.collab/cursors/<machine-slug>/<transport>/<participant-key>-<slug>.json
 *
 * The harness is deliberately absent from that path. It used to be a directory segment AND
 * a substring of the filename, so an agent whose harness reading changed came back to a
 * cursor file that did not exist and silently re-read from zero. The harness is advisory;
 * a read position is not.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseTriplet, identityKeyFromTriplet } from './collab-identity.mjs';

export const FAST_POLL_SECONDS = 30;
export const FAST_POLL_WINDOW_MINUTES = 5;
export const BASE_CADENCE_MINUTES = 5;
export const IDLE_CADENCE_MINUTES = 15;
export const IDLE_THRESHOLD_MINUTES = 30;

/**
 * Derive the machine slug from hostname.
 * @returns {string} Lowercase hostname without domain, hyphens for spaces.
 */
export function deriveMachineSlug() {
  try {
    return execFileSync('hostname', ['-s'], { encoding: 'utf8' }).trim().toLowerCase().replace(/\s+/g, '-');
  } catch {
    return 'unknown-machine';
  }
}

/**
 * Slugify a transport identifier for use in a filesystem path.
 * 'github:files' → 'github-files'; 'localhost' → 'localhost'.
 * For github transports the repo IS the identity, so it's encoded here.
 */
export function encodeTransport(transport) {
  if (!transport) return 'unknown-transport';
  return String(transport).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Derive the cursor file path for a participant.
 *
 * Cursor identity MUST include transport + repo/root (v1.0 plan §3.1, HC blocker #1):
 * the same participant+slug can legitimately exist on two transports (localhost AND
 * github:files), and they must not collide on one cursor file.
 *
 * Cursor identity must NOT include the harness. The harness is advisory and free to move;
 * a read position that moves with it is lost, and losing it is silent — the reader just
 * starts over from an empty cursor. So the participant key is the workspace and machine
 * components only.
 *
 * Path: ~/.collab/cursors/<machine>/<transport>/<workspace>--<machine>-<slug>.json
 *
 * @param {string} triplet — participant triplet (e.g., 'core-framework@claude-code:Jennifer-Aniston')
 * @param {string} slug — collab slug
 * @param {object} [opts] — { machineSlug, transport }
 * @returns {string} Absolute path to cursor file
 */
export function cursorFilePath(triplet, slug, opts = {}) {
  // Back-compat: allow opts to be a string machineSlug (old 3-arg signature).
  const o = (typeof opts === 'string') ? { machineSlug: opts } : (opts || {});
  const machine = o.machineSlug || deriveMachineSlug();
  const transport = encodeTransport(o.transport || 'unknown-transport');
  const filename = `${identityKeyFromTriplet(triplet)}-${slug}.json`;
  return join(homedir(), '.collab', 'cursors', machine, transport, filename);
}

/**
 * Cursor files written by an install that still partitioned by harness.
 *
 * Layout then: <cursors>/<machine>/<harness>/<transport>/<workspace>-<harness>-<machine>-<slug>.json
 * Layout now:  <cursors>/<machine>/<transport>/<workspace>--<machine>-<slug>.json
 *
 * Both segments are recovered from `cursorPath` itself, so this works no matter how the
 * caller built it. A harness directory only counts as one if it actually contains the
 * transport directory underneath, which is what keeps the new layout from matching itself.
 */
export function legacyCursorFilePaths(cursorPath, triplet, slug) {
  const transportSeg = basename(dirname(cursorPath));
  const machineDir = dirname(dirname(cursorPath));
  const p = parseTriplet(triplet);
  if (!p || !existsSync(machineDir)) return [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = new RegExp(`^${esc(p.workspaceId)}-.+-${esc(p.machine)}-${esc(slug)}\\.json$`);
  const found = [];
  let entries;
  try { entries = readdirSync(machineDir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(machineDir, e.name, transportSeg);
    if (!existsSync(dir)) continue;
    let files;
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) if (nameRe.test(f)) found.push(join(dir, f));
  }
  return found.sort();
}

/**
 * Read cursor state from disk. Returns default state if file not found.
 * @param {string} cursorPath — absolute path to cursor file
 * @param {string} triplet — participant triplet
 * @param {string} slug — collab slug
 * @param {string} transport — 'github:files' | 'localhost'
 * @returns {object} cursor state
 */
export function readCursorState(cursorPath, triplet, slug, transport) {
  const defaults = {
    slug,
    transport,
    participant_triplet: triplet,
    machine: deriveMachineSlug(),
    // Advisory only. Recorded so a human reading the cursor knows where it was last
    // written from; nothing routes on it and nothing is partitioned by it.
    harness: parseTriplet(triplet)?.harness || 'unknown',
    last_seen_event_id: null,
    last_posted_at: null,
    fast_poll_window_expires_at: null,
    base_cadence_minutes: BASE_CADENCE_MINUTES,
    fast_poll_minutes: FAST_POLL_SECONDS / 60,
    last_committed_next_update_by: null,
    commitment_drift_state: 'unknown',
  };
  // Read forward from a harness-partitioned cursor written by an older install, rather than
  // silently restarting from an empty read position.
  let readFrom = cursorPath;
  if (!existsSync(readFrom)) {
    readFrom = legacyCursorFilePaths(cursorPath, triplet, slug)[0];
    if (!readFrom) return defaults;
  }
  try {
    const raw = JSON.parse(readFileSync(readFrom, 'utf8'));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

/**
 * Write cursor state to disk atomically.
 * @param {string} cursorPath — absolute path to cursor file
 * @param {object} state — cursor state to persist
 */
export function writeCursorState(cursorPath, state) {
  const dir = dirname(cursorPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${cursorPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  // renameSync is atomic on POSIX — race-safe for concurrent readers.
  renameSync(tmp, cursorPath);
}

/**
 * Compute the current cadence mode given cursor state and now.
 * @param {object} state — cursor state
 * @param {string} lastEventAt — ISO timestamp of most recent event (any participant)
 * @param {Date} [now] — current time (defaults to new Date())
 * @returns {{ mode: 'fast-poll' | 'base' | 'idle', sleepMs: number, reason: string }}
 */
export function computeCadence(state, lastEventAt, now) {
  const t = now || new Date();

  // Fast-poll window active?
  if (state.fast_poll_window_expires_at) {
    const expires = new Date(state.fast_poll_window_expires_at);
    if (t < expires) {
      return {
        mode: 'fast-poll',
        sleepMs: FAST_POLL_SECONDS * 1000,
        reason: `fast-poll window active until ${expires.toISOString()}`,
      };
    }
  }

  // Idle check: no events from any participant for >IDLE_THRESHOLD_MINUTES
  if (lastEventAt) {
    const lastEvent = new Date(lastEventAt);
    const minutesSinceLastEvent = (t - lastEvent) / (1000 * 60);
    if (minutesSinceLastEvent > IDLE_THRESHOLD_MINUTES) {
      return {
        mode: 'idle',
        sleepMs: IDLE_CADENCE_MINUTES * 60 * 1000,
        reason: `${Math.round(minutesSinceLastEvent)}min since last event (idle threshold: ${IDLE_THRESHOLD_MINUTES}min)`,
      };
    }
  }

  // Default: base cadence
  return {
    mode: 'base',
    sleepMs: BASE_CADENCE_MINUTES * 60 * 1000,
    reason: 'base cadence',
  };
}

/**
 * Activate fast-poll window (call after posting or receiving an event).
 * Mutates state in place; caller must writeCursorState afterward.
 * @param {object} state — cursor state
 * @param {Date} [now] — current time (defaults to new Date())
 */
export function activateFastPollWindow(state, now) {
  const t = now || new Date();
  const expires = new Date(t.getTime() + FAST_POLL_WINDOW_MINUTES * 60 * 1000);
  state.fast_poll_window_expires_at = expires.toISOString();
}

/**
 * Update cursor with commitment tracking (reads next_update_by from received event).
 * Mutates state in place; caller must writeCursorState afterward.
 * @param {object} state — cursor state
 * @param {object} receivedEvent — received event object
 * @param {Date} [now] — current time
 */
export function updateCommitmentTracking(state, receivedEvent, now) {
  const t = now || new Date();
  const nextUpdateBy = receivedEvent?.payload?.next_update_by;
  if (nextUpdateBy) {
    state.last_committed_next_update_by = nextUpdateBy;
    const deadline = new Date(nextUpdateBy);
    if (t > deadline) {
      const driftMs = t - deadline;
      state.commitment_drift_seconds = Math.round(driftMs / 1000);
      state.commitment_drift_state = driftMs > 5 * 60 * 1000 ? 'missed' : 'late';
    } else {
      state.commitment_drift_state = 'on-time';
      state.commitment_drift_seconds = 0;
    }
  }
}
