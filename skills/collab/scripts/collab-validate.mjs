/**
 * collab-validate.mjs — schema validation for events.jsonl.
 * CLI: node collab-validate.mjs <slug>
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findCollabDir, readEvents } from './collab-event-helpers.mjs';
import { validateMeasures } from './collab-kickoff.mjs';

// Participant-authored types, then the three the system writes for itself:
// `reconciled` on a healed foreign surface, `quarantined` on a rejected v1 event,
// `timeout-action` when a declared timeout policy executes.
const VALID_TYPES = ['kickoff','join','decline','turn','propose-close','ratify','object','withdraw','close',
                     'reconciled','quarantined','timeout-action'];
const VALID_INTENTS = ['propose','critique','probe','synthesize','clarify'];
// `converged` and the `aborted-*` family, then the two honest terminal modes for a goal
// that ran the ladder out: `complete-to-authority-boundary` (work landed, but a ratified
// completion measure has no review attached) and `failed-safely` (the goal did not
// complete, and nothing was left broken or half-written).
const VALID_OUTCOMES = ['converged','aborted-stall','aborted-budget','aborted-objection','aborted-david',
                        'complete-to-authority-boundary','failed-safely'];
const TRANSPORT_RE = /^(localhost|github:[a-z0-9_-]+)$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const REQUIRED_PAYLOAD = {
  kickoff: ['message','igm','capabilities_wanted','wall_clock_hours'],
  join: ['capability_match','commitment'], decline: ['reason'],
  turn: ['intent','body','signals'], 'propose-close': ['synthesis','igm_met'],
  ratify: [], object: ['reason'], withdraw: [], close: ['final_synthesis','outcome'],
};

export function validateEvents(events) {
  const errors = [], warnings = [], seenIds = new Set();
  // Eligibility v1 state, in ledger order. `declared` is the kickoff's measure list; `judged`
  // records only SCOPED verdicts per author, so a legacy ledger (bare verdicts) can never
  // produce a new error here — interpret by shape, guarantee at write.
  const declared = new Map();
  const judged = new Map();
  const owedBy = (author) => [...declared.values()].filter(m => m.requires_review_from === author).map(m => m.id);
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const tag = `evt[${i}]${e.event_id ? ' ' + e.event_id : ''}`;
    if (e.type === 'kickoff' && Array.isArray(e.payload?.ratified_completion_measures)) {
      for (const m of e.payload.ratified_completion_measures) if (m && typeof m.id === 'string') declared.set(m.id, m);
      for (const err of validateMeasures(e.payload.ratified_completion_measures)) errors.push(`${tag} ${err}`);
    }
    if (e.type === 'join' && declared.size && 'owes_review' in (e.payload || {})) {
      const ack = Array.isArray(e.payload.owes_review) ? e.payload.owes_review : [];
      for (const id of ack) {
        if (!declared.has(id)) errors.push(`${tag} measure-unknown: ${id}`);
        else if (declared.get(id).requires_review_from !== e.author) errors.push(`${tag} owes-review-not-owed: ${id}`);
      }
      const owed = owedBy(e.author);
      if (owed.length && owed.some(id => !ack.includes(id))) {
        warnings.push(`${tag} review-ack-mismatch: ${e.author} is named by ${owed.join(', ')} but acknowledged ${ack.filter(id => owed.includes(id)).join(', ') || 'none'}`);
      }
    }
    if ((e.type === 'ratify' || e.type === 'object') && declared.size && 'measures' in (e.payload || {})) {
      const owed = owedBy(e.author);
      const ids = Array.isArray(e.payload.measures) ? e.payload.measures : [];
      if (!owed.length) {
        warnings.push(`${tag} verdict-measures-ignored: ${e.author} owes no measure; field ignored`);
      } else if (!Array.isArray(e.payload.measures) || ids.length === 0) {
        errors.push(`${tag} verdict-unscoped: ${e.author} owes ${owed.join(', ')}; a verdict from a named reviewer must list the measures it discharges`);
      } else {
        const mine = judged.get(e.author) || new Set();
        let ok = true;
        for (const id of ids) {
          if (!declared.has(id)) { errors.push(`${tag} measure-unknown: ${id}`); ok = false; }
          else if (!owed.includes(id)) { errors.push(`${tag} verdict-reviewer-mismatch: ${e.author} ${id}`); ok = false; }
          else if (mine.has(id)) { errors.push(`${tag} verdict-duplicate: ${e.author} ${id}`); ok = false; }
        }
        // Whole-event semantics: a refused verdict credits nothing, so it judges nothing.
        if (ok) { for (const id of ids) mine.add(id); judged.set(e.author, mine); }
      }
    }
    for (const f of ['event_id','ts','author','slug','type']) {
      if (e[f] == null) errors.push(`${tag} missing required field: ${f}`);
    }
    if (!e.payload && e.payload !== 0) errors.push(`${tag} missing payload`);
    if (e.event_id) {
      if (seenIds.has(e.event_id)) errors.push(`duplicate event_id: ${e.event_id}`);
      seenIds.add(e.event_id);
    }
    if (e.type && !VALID_TYPES.includes(e.type)) errors.push(`${tag} unknown type: ${e.type}`);
    for (const f of (REQUIRED_PAYLOAD[e.type] || [])) {
      if (!e.payload || e.payload[f] == null) errors.push(`${tag} (${e.type}) missing payload field: ${f}`);
    }
    if (e.type === 'turn' && e.payload?.intent != null && !VALID_INTENTS.includes(e.payload.intent))
      errors.push(`${tag} turn has unknown intent: ${e.payload.intent}`);
    if (e.type === 'close' && e.payload?.outcome != null && !VALID_OUTCOMES.includes(e.payload.outcome))
      errors.push(`${tag} close has unknown outcome: ${e.payload.outcome}`);
    if (e.type === 'kickoff' && e.payload?.tick_interval_minutes != null) {
      const tim = e.payload.tick_interval_minutes;
      if (typeof tim !== 'number' || !Number.isFinite(tim) || tim < 1 || tim > 1440)
        errors.push(`${tag} kickoff tick_interval_minutes must be a number between 1 and 1440 (got: ${tim})`);
    }
    if (e.type === 'kickoff' && e.payload?.pin != null) {
      if (typeof e.payload.pin !== 'string' || !/^\d{6}$/.test(e.payload.pin))
        errors.push(`${tag} kickoff pin must be a 6-digit string (got: ${e.payload.pin})`);
    }
    if (e.type === 'kickoff') {
      if ('transport' in (e.payload || {})) {
        if (typeof e.payload.transport !== 'string' || !TRANSPORT_RE.test(e.payload.transport)) {
          errors.push(`${tag} kickoff transport must match ${TRANSPORT_RE} (got: ${JSON.stringify(e.payload.transport)})`);
        }
      } else {
        warnings.push(`${tag} kickoff missing transport field (v0.1.x compat — treated as github:files at read time)`);
      }
      if ('ratification_window_minutes' in (e.payload || {})) {
        const r = e.payload.ratification_window_minutes;
        if (typeof r !== 'number' || !Number.isFinite(r) || r < 1 || r > 1440) {
          errors.push(`${tag} kickoff ratification_window_minutes must be a number between 1 and 1440 (got: ${JSON.stringify(r)})`);
        }
      }
      if ('ratified_completion_measures' in (e.payload || {})) {
        const ms = e.payload.ratified_completion_measures;
        if (!Array.isArray(ms)) {
          errors.push(`${tag} kickoff ratified_completion_measures must be an array (got: ${JSON.stringify(ms)})`);
        } else {
          ms.forEach((m, j) => {
            const at = `${tag} ratified_completion_measures[${j}]`;
            if (typeof m !== 'object' || m === null) {
              errors.push(`${at} must be an object with id + requires_review_from`);
              return;
            }
            if (typeof m.id !== 'string' || m.id === '')
              errors.push(`${at} missing a non-empty string id`);
            // The whole point of the field is naming WHO owes the review. A measure that
            // names no reviewer cannot be discharged and cannot be reported as missing.
            if (typeof m.requires_review_from !== 'string' || m.requires_review_from === '')
              errors.push(`${at} missing a non-empty requires_review_from participant triplet`);
          });
        }
      }
      if ('min_collab_plugin_version' in (e.payload || {})) {
        const v = e.payload.min_collab_plugin_version;
        if (typeof v !== 'string' || !SEMVER_RE.test(v)) {
          errors.push(`${tag} kickoff min_collab_plugin_version must be a semver string matching ${SEMVER_RE} (got: ${JSON.stringify(v)})`);
        }
      }
    }
    if (i > 0 && e.ts && events[i-1].ts) {
      if (Math.abs(new Date(e.ts) - new Date(events[i-1].ts)) > 3600000)
        warnings.push(`${tag} clock skew >1h from ${events[i-1].event_id}`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export function main(argv) {
  const slug = argv[0];
  if (!slug) { process.stderr.write('usage: collab-validate.mjs <slug>\n'); return 2; }
  const dir = findCollabDir(slug);
  if (!dir) { process.stderr.write(`no collab found: ${slug}\n`); return 2; }
  const result = validateEvents(readEvents(dir));
  if (result.warnings.length) process.stderr.write('Warnings:\n' + result.warnings.map(w => '  '+w).join('\n') + '\n');
  if (result.errors.length) { process.stderr.write('Errors:\n' + result.errors.map(e => '  '+e).join('\n') + '\n'); return 1; }
  process.stdout.write(`OK — ${readEvents(dir).length} events valid\n`);
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
