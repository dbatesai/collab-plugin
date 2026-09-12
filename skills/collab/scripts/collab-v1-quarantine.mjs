/**
 * collab-v1-quarantine.mjs — v1 event validation + quarantine (HC blocker #3).
 *
 * v1.0 plan §5: v1 emitters MUST carry the typed-contract fields. An event that
 * declares itself v1 (payload.schema_version major >= 1) but is missing required
 * fields is QUARANTINED before tick/chase routing — it does not participate.
 * Legacy v0.2 events (no schema_version) WARN only; they still route.
 *
 * Quarantine is non-destructive: the event file events/<id>.json is renamed to
 * events/.quarantined-<id>.json (dot-prefixed → skipped by readEvents). Content
 * is preserved with an added _quarantine block for audit.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  appendEvent, readEvents, generateEventId, authorSlugFromTriplet, eventFilenameViolations } from './collab-event-helpers.mjs';

// v1 turn events require these payload fields (typed handoff contract).
export const V1_REQUIRED_TURN_FIELDS = ['state', 'owner', 'waiting_on', 'next_update_by'];
export const V1_VALID_STATES = ['working', 'blocked', 'verifying', 'done'];
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Does this event declare itself as v1 (schema_version major >= 1)?
 * Legacy v0.2 events have no schema_version → not v1.
 */
export function isV1Event(event) {
  const sv = event?.payload?.schema_version ?? event?.schema_version;
  if (!sv) return false;
  const major = parseInt(String(sv).split('.')[0], 10);
  return Number.isFinite(major) && major >= 1;
}

/**
 * Validate an event. Returns { tier, valid, reason }.
 *   tier: 'v1' | 'legacy'
 *   valid: boolean (legacy is always valid here; warn-only handled by caller)
 *   reason: string code when invalid, else null
 *
 * Only `turn` events carry the v1 typed-handoff contract; other v1 event types
 * (ratify/object/etc.) are validated for provenance only.
 */
export function validateEventForRouting(event) {
  if (!isV1Event(event)) {
    return { tier: 'legacy', valid: true, reason: null };
  }
  // v1: provenance with emit_mode is required on every v1 emit.
  const prov = event?.payload?.provenance;
  if (!prov || typeof prov !== 'object' || !prov.emit_mode) {
    return { tier: 'v1', valid: false, reason: 'missing-provenance' };
  }
  if (event.type === 'turn') {
    const p = event.payload || {};
    for (const f of V1_REQUIRED_TURN_FIELDS) {
      if (!(f in p)) return { tier: 'v1', valid: false, reason: `missing-field:${f}` };
    }
    if (p.state != null && !V1_VALID_STATES.includes(p.state)) {
      return { tier: 'v1', valid: false, reason: `invalid-state:${p.state}` };
    }
    // next_update_by must be machine-parseable ISO 8601 (NOT a human string).
    // This is the exact interop bug found session 52 — HC's watcher emitted
    // "2026-05-29 1:00:00 AM EDT" into the schema field, breaking drift math.
    if (p.next_update_by != null && p.next_update_by !== '' && !ISO_RE.test(p.next_update_by)) {
      return { tier: 'v1', valid: false, reason: 'next_update_by-not-iso8601' };
    }
  }
  return { tier: 'v1', valid: true, reason: null };
}

/**
 * Quarantine an event file: rename events/<id>.json → events/.quarantined-<id>.json,
 * embedding a _quarantine audit block. Non-destructive (content preserved).
 * Returns the quarantine path, or null if the source file is absent.
 */
export function quarantineEvent(collabDir, event, reason, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  const eventsDir = join(collabDir, 'events');
  // Refuse before any mutation while the channel holds a file not named for its event —
  // the same hard stop as every other write boundary, enforced here because this is an
  // exported primitive that may be called directly.
  const violations = eventFilenameViolations(collabDir);
  if (violations.length) {
    throw new Error(`event-filename-violation: ${violations.join(', ')} — refusing to quarantine anything while a file under events/ is not named for the event it contains`);
  }
  // The file this acts on is the file that was READ — never a path rebuilt from the event's
  // id, which is untrusted input and could name somebody else's valid file. The supplied
  // event must BE the bytes at that source: a caller cannot retarget canonical history by
  // handing this function an object that merely carries a published id.
  const sourceName = opts.sourceName || `${event.event_id}.json`;
  if (sourceName !== `${event.event_id}.json`) {
    throw new Error(`event-filename-violation: refusing to quarantine ${sourceName}, which is not named for the event it contains (${event.event_id})`);
  }
  const stem = sourceName.slice(0, -5);
  const src = join(eventsDir, sourceName);
  if (!existsSync(src)) return null;
  let atSource;
  try { atSource = JSON.parse(readFileSync(src, 'utf8')); } catch { return null; }
  if (JSON.stringify(atSource) !== JSON.stringify(event)) {
    throw new Error(`quarantine-source-mismatch: the supplied event does not re-serialize to the parsed content of events/${sourceName} (key order included); nothing was moved`);
  }
  const dst = join(eventsDir, `.quarantined-${stem}.json`);
  const quarantined = {
    ...atSource,
    _quarantine: { reason, quarantined_at: now(), original_file: sourceName },
  };
  // Write the quarantine artifact first (atomic via tmp), then remove the source.
  const tmp = join(eventsDir, `.tmp-q-${stem}-${process.pid}.json`);
  writeFileSync(tmp, JSON.stringify(quarantined, null, 2));
  renameSync(tmp, dst);
  if (existsSync(src)) {
    try { renameSync(src, join(eventsDir, `.superseded-${stem}.json`)); }
    catch { /* source already moved */ }
  }
  return dst;
}

/**
 * Scan an events dir, quarantine invalid v1 events, and return a report.
 * Legacy invalid events are reported as warnings but NOT quarantined.
 * @returns {{ quarantined: Array<{event_id, reason}>, warnings: Array<{event_id, reason}> }}
 */
export function quarantineInvalidV1Events(collabDir, opts = {}) {
  const eventsDir = join(collabDir, 'events');
  const report = { quarantined: [], warnings: [], notices: [], refused: null };
  if (!existsSync(eventsDir)) return report;
  // A file whose name is not its event id is a hard stop here too: nothing is moved,
  // written, or announced while one is present. Refusal precedes every mutation.
  const violations = eventFilenameViolations(collabDir);
  if (violations.length) { report.refused = { reason: 'event-filename-violation', paths: violations }; return report; }

  // Ids already announced, so a tick every cycle does not flood the ledger with notices.
  const alreadyNoticed = new Set(
    readEvents(collabDir)
      .filter(e => e.type === 'quarantined')
      .map(e => e.payload?.quarantined_event_id)
      .filter(Boolean),
  );

  for (const name of readdirSync(eventsDir)) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    let event;
    try { event = JSON.parse(readFileSync(join(eventsDir, name), 'utf8')); }
    catch { continue; }
    if (!event || typeof event !== 'object' || name !== `${event.event_id}.json`) continue;
    const v = validateEventForRouting(event);
    if (v.valid) continue;
    if (v.tier === 'v1') {
      quarantineEvent(collabDir, event, v.reason, { ...opts, sourceName: name });
      report.quarantined.push({ event_id: event.event_id, reason: v.reason });

      // Preserving bytes is not sufficient: without a routed notice, the only path from
      // "quarantined" to "anyone knows" runs through a peer inspecting the directory.
      if (opts.author && !alreadyNoticed.has(event.event_id)) {
        const notice = emitQuarantineNotice(collabDir, event, v.reason, opts);
        alreadyNoticed.add(event.event_id);
        report.notices.push({ event_id: notice.event_id, quarantined_event_id: event.event_id });
      }
    } else {
      report.warnings.push({ event_id: event.event_id, reason: v.reason });
    }
  }
  return report;
}

/**
 * Emit a routed `quarantined` event so a suppressed peer event is visible through a normal
 * receive cycle rather than only by directory inspection. Carries provenance so the notice
 * itself passes v1 validation and cannot be quarantined by the next scan.
 */
function emitQuarantineNotice(collabDir, event, reason, opts = {}) {
  const now = opts.now || (() => new Date().toISOString());
  const ts = now();
  const author = opts.author;
  const notice = {
    event_id: generateEventId(ts, authorSlugFromTriplet(author)),
    ts, author, slug: event.slug ?? '',
    type: 'quarantined',
    references: [event.event_id],
    payload: {
      schema_version: '1.0',
      provenance: { emit_mode: 'automated', harness: 'quarantine-scan' },
      quarantined_event_id: event.event_id,
      quarantined_author: event.author,
      quarantined_type: event.type,
      reason,
      artifact: `.quarantined-${event.event_id}.json`,
      note: 'Event failed v1 validation and does not route. Content is preserved and readable '
          + 'at the artifact path. It counts as nothing until its author posts a valid replacement.',
      signals: ['quarantined', reason],
    },
  };
  appendEvent(collabDir, notice);
  return notice;
}
