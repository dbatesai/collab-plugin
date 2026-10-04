#!/usr/bin/env node
/**
 * collab-outcome.mjs — the deterministic outcome of an anchored collab. Pure: reads, never writes.
 *
 * The outcome is a function of the terminal prefix: every event whose order slot is at or
 * before the first close slot (collab-anchor.mjs). Its bytes are canonical JSON (keys sorted
 * at every level, no whitespace, one trailing LF), so every reader of the same anchored ledger
 * derives identical bytes. Events anchored after the close are `late`: kept, listed, excluded.
 *
 * Refusals are named and stop the outcome: an anchored event whose bytes changed or vanished
 * (`ledger-mutated`, `orphan-slot`), an unparseable slot (`bad-slot`), or a collab with no
 * order log (`no-anchor`). Events with no slot yet are listed as `unanchored`.
 *
 * CLI: node collab-outcome.mjs <collab-dir> [--participant <triplet>] [--bytes]
 *   default: one JSON report line; --bytes: the canonical outcome bytes only (exit 3 if none).
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAnchored, readSlots, sha256 } from './collab-anchor.mjs';
import { measureVerdicts } from './collab-event-helpers.mjs';

export const MAPPING = 'collab-outcome/1';

export function canonicalJson(value) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(value)) + '\n';
}

export function computeOutcome(collabDir, { participant = null } = {}) {
  const report = { status: 'open', mapping: MAPPING, collab_dir: basename(collabDir), refusals: [], unanchored: [], duplicate_slots: [], late: [] };
  if (!isAnchored(collabDir)) { report.status = 'refused'; report.refusals.push('no-anchor'); return report; }

  const { slots, bad } = readSlots(collabDir);
  for (const seq of bad) report.refusals.push(`bad-slot ${seq}`);

  // An event's anchor is its lowest slot; a later slot naming it again is a named placeholder.
  const firstSlot = new Map();
  const events = new Map();
  for (const s of slots) {
    if (firstSlot.has(s.event_id)) { report.duplicate_slots.push(s.seq); continue; }
    firstSlot.set(s.event_id, s);
    const path = join(collabDir, 'events', `${s.event_id}.json`);
    if (!existsSync(path)) { report.refusals.push(`orphan-slot ${s.seq}`); continue; }
    const bytes = readFileSync(path);
    if (sha256(bytes) !== s.sha256) { report.refusals.push(`ledger-mutated ${s.event_id}`); continue; }
    events.set(s.event_id, JSON.parse(bytes.toString('utf8')));
  }
  const eventsDir = join(collabDir, 'events');
  if (existsSync(eventsDir)) {
    for (const n of readdirSync(eventsDir)) {
      if (!n.endsWith('.json') || n.startsWith('.')) continue;   // the filter readEvents uses
      if (!firstSlot.has(n.slice(0, -5))) report.unanchored.push(n.slice(0, -5));
    }
  }
  if (report.refusals.length) { report.status = 'refused'; return report; }

  const ordered = slots.filter(s => firstSlot.get(s.event_id) === s);
  const kickoffSlot = ordered.find(s => events.get(s.event_id)?.type === 'kickoff');
  if (!kickoffSlot) { report.status = 'refused'; report.refusals.push('no-kickoff'); return report; }
  report.collab_id = kickoffSlot.sha256;

  const closeIdx = ordered.findIndex(s => events.get(s.event_id).type === 'close');
  const prefixSlots = closeIdx === -1 ? ordered : ordered.slice(0, closeIdx + 1);
  const prefix = prefixSlots.map(s => events.get(s.event_id));
  if (participant) report.joined = prefix.some(e => e.type === 'join' && (e.author === participant || e.participant_id === participant));
  if (closeIdx === -1) return report;

  report.late = ordered.slice(closeIdx + 1).map(s => s.event_id);
  const kickoff = events.get(kickoffSlot.event_id);
  const close = prefix[prefix.length - 1];
  const credited = {};
  for (const [id, v] of measureVerdicts(prefix)) {
    credited[id] = { ratified: v.ratified.map(c => c.event_id), objected: v.objected.map(c => c.event_id) };
  }
  const outcome = {
    schema: MAPPING,
    collab_id: report.collab_id,
    slug: kickoff.slug,
    kickoff: {
      event_id: kickoff.event_id, author: kickoff.author,
      message: kickoff.payload?.message ?? null, igm: kickoff.payload?.igm ?? null,
      measures: kickoff.payload?.ratified_completion_measures ?? [],
    },
    participants: [...new Set(prefix.filter(e => e.type === 'join').map(e => e.author))].sort(),
    verdicts: prefix.filter(e => e.type === 'ratify' || e.type === 'object').map(e => ({
      event_id: e.event_id, author: e.author, type: e.type,
      measures: e.payload?.measures ?? null, reason: e.payload?.reason ?? null,
    })),
    credited,
    close: { event_id: close.event_id, author: close.author, payload: close.payload ?? null },
    prefix: prefixSlots.map(s => ({ seq: s.seq, event_id: s.event_id, sha256: s.sha256 })),
  };
  const bytes = canonicalJson(outcome);
  Object.assign(report, { status: 'closed', origin_anchor: `localhost:${prefixSlots[prefixSlots.length - 1].seq}`, outcome_sha256: sha256(bytes), outcome_bytes: bytes });
  return report;
}

export function main(argv) {
  let dir = null, participant = null, bytesOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--participant') participant = argv[++i];
    else if (argv[i] === '--bytes') bytesOnly = true;
    else if (!argv[i].startsWith('--')) dir = argv[i];
  }
  if (!dir) { process.stderr.write('usage: collab-outcome.mjs <collab-dir> [--participant <triplet>] [--bytes]\n'); return 2; }
  const r = computeOutcome(dir, { participant });
  if (bytesOnly) {
    if (r.status !== 'closed') { process.stderr.write(`no outcome: ${r.status} ${r.refusals.join('; ')}\n`); return 3; }
    process.stdout.write(r.outcome_bytes);
    return 0;
  }
  process.stdout.write(JSON.stringify(r) + '\n');
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && _c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
