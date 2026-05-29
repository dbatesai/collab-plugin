/**
 * collab-loop.mjs — loop lifecycle command for collab-plugin v1.0.
 *
 * Subcommands:
 *   start <slug>   — join in loop mode, init cursor, return recommended cadence
 *   status <slug>  — render typed status block + cadence state + obligations
 *   stop <slug>    — persist cursor, exit loop (does NOT close the collab)
 *
 * DESIGN: this command does NOT block-sleep in-process. Per the v1.0 plan
 * (Codex cannot run background loops), it computes the recommended next-tick
 * cadence and persists cursor state; the HARNESS drives re-entry:
 *   - Claude Code: native /loop or ScheduleWakeup at the returned interval
 *   - Codex: supervised re-entry at the returned interval
 *   - Generic: a foreground wrapper the user starts intentionally
 *
 * CLI: node collab-loop.mjs <start|status|stop> <slug> [--workspace-id <id>] [--transport <t>]
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findCollabAcrossTransports, readEvents, getJoinedAgents,
  isClosed, findActiveProposeClose, checkSafetyNets, deriveTriplet,
} from './collab-event-helpers.mjs';
import {
  cursorFilePath, readCursorState, writeCursorState,
  computeCadence, activateFastPollWindow, updateCommitmentTracking,
} from './collab-cadence.mjs';
import { runPreflight } from './collab-preflight.mjs';
import { tickDeterministic } from './collab-tick.mjs';

const GRACE_MINUTES = 5;

/**
 * Render a 12-hour LOCAL SYSTEM time string with full date, seconds, and the
 * actual timezone abbreviation (v1.0 plan, HC blocker #7). Does NOT hardcode a
 * timezone — uses the host's local zone so the rendering is correct on whatever
 * machine/harness runs it.
 */
export function localTime(iso) {
  if (!iso) return '(none)';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    // Target shape: "2026-05-29 1:10:00 AM EDT"
    //   - ISO-like date YYYY-MM-DD (local)
    //   - 12-hour clock, NO leading-zero hour
    //   - seconds always shown
    //   - real local timezone abbreviation (EDT/PST/UTC/...)
    const parts = new Intl.DateTimeFormat('en-US', {
      hour12: true,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short',
    }).formatToParts(d);
    const get = (t) => (parts.find(p => p.type === t)?.value ?? '');
    const yyyy = get('year'), mm = get('month'), dd = get('day');
    const hour = get('hour'), min = get('minute'), sec = get('second');
    const ampm = get('dayPeriod'); // 'AM' | 'PM'
    const tz = get('timeZoneName'); // 'EDT' etc.
    return `${yyyy}-${mm}-${dd} ${hour}:${min}:${sec} ${ampm} ${tz}`;
  } catch { return iso; }
}

/**
 * Compute per-participant obligation state from events.
 * Returns array of { participant, last_actual_update_at, last_committed_next_update_by, drift_state }.
 */
export function computeObligations(events, nowIso) {
  const now = new Date(nowIso || new Date().toISOString());
  const joined = getJoinedAgents(events);
  const obligations = [];
  for (const participant of joined) {
    const theirEvents = events.filter(e => e.author === participant && e.type === 'turn');
    const last = theirEvents[theirEvents.length - 1];
    const lastActual = last ? last.ts : null;
    const committed = last?.payload?.next_update_by || null;
    let driftState = 'unknown';
    if (committed) {
      const deadline = new Date(committed);
      if (now <= deadline) driftState = 'on-time';
      else driftState = (now - deadline) > GRACE_MINUTES * 60 * 1000 ? 'missed' : 'late';
    }
    obligations.push({
      participant,
      last_actual_update_at: lastActual,
      last_committed_next_update_by: committed,
      drift_state: driftState,
    });
  }
  return obligations;
}

/**
 * Render the typed status block (State/Owner/Last-action/Waiting-on/Next-check/Risk).
 */
export function renderStatusBlock(events, slug, cadence, obligations) {
  const closeEvt = events.find(e => e.type === 'close');
  const propose = findActiveProposeClose(events);
  const net = checkSafetyNets(events, new Date().toISOString());
  const lastTurn = [...events].reverse().find(e => e.type === 'turn');

  const state = closeEvt ? `closed (${closeEvt.payload.outcome})`
    : net ? `safety-net:${net}`
    : propose ? 'propose-close pending'
    : lastTurn?.payload?.state || 'active';
  const owner = lastTurn?.payload?.owner || '(unspecified)';
  const waiting = lastTurn?.payload?.waiting_on || '(none)';
  const nextCheck = lastTurn?.payload?.next_update_by;

  const lines = [];
  lines.push(`\n── collab-loop status: ${slug} ──────────────────────`);
  lines.push(`State:      ${state}`);
  lines.push(`Owner:      ${owner}`);
  lines.push(`Waiting on: ${waiting}`);
  lines.push(`Next check: ${localTime(nextCheck)}`);
  lines.push(`Cadence:    ${cadence.mode} (sleep ${Math.round(cadence.sleepMs / 1000)}s) — ${cadence.reason}`);
  lines.push(`Events:     ${events.length}`);
  lines.push('');
  lines.push('Participant obligations:');
  for (const o of obligations) {
    const flag = o.drift_state === 'missed' ? ' ⚠ MISSED' : o.drift_state === 'late' ? ' (late)' : '';
    lines.push(`  ${o.participant}: ${o.drift_state}${flag}`);
    lines.push(`    last update: ${localTime(o.last_actual_update_at)}`);
    lines.push(`    committed by: ${localTime(o.last_committed_next_update_by)}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function main(argv) {
  const sub = argv[0];
  let slug = null, workspaceId = null, transport = null;
  let minVersionOpt = null, justificationOpt = null;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--transport') transport = argv[++i];
    else if (argv[i] === '--min-version') minVersionOpt = argv[++i];
    else if (argv[i] === '--justification') justificationOpt = argv[++i];
    else if (!argv[i].startsWith('--') && slug === null) slug = argv[i];
  }
  if (!sub || !slug) {
    process.stderr.write('usage: collab-loop.mjs <start|status|stop> <slug> [--workspace-id <id>] [--justification <reason>]\n');
    return 2;
  }

  const hit = findCollabAcrossTransports(slug);
  if (!hit) { process.stderr.write(`no collab: ${slug}\n`); return 2; }
  const events = readEvents(hit.dir);
  const triplet = deriveTriplet(workspaceId || 'unknown');
  const cursorPath = cursorFilePath(triplet, slug, { transport: hit.transport });
  const state = readCursorState(cursorPath, triplet, slug, hit.transport);

  const nowIso = new Date().toISOString();
  const lastEvent = events[events.length - 1];
  const lastEventAt = lastEvent ? lastEvent.ts : null;

  if (sub === 'start') {
    // v1.0 #2: preflight gate before entering the loop.
    // collab-loop start is the preflight/cursor wrapper around the existing tick semantics,
    // NOT a second tick brain. It validates the preconditions, then delegates to tickDeterministic.
    const pf = runPreflight({ slug, minVersion: minVersionOpt, justification: justificationOpt });
    if (!pf.pass) {
      console.log(JSON.stringify({ action: 'preflight-blocked', blockers: pf.blockers, warnings: pf.warnings }, null, 2));
      return 1;
    }
    if (pf.warnings.length > 0) {
      process.stderr.write(`[collab-loop] preflight warnings:\n${pf.warnings.map(w => `  ${w.code}: ${w.message}`).join('\n')}\n`);
    }

    // Init/refresh cursor; activate fast-poll so the loop starts responsive.
    activateFastPollWindow(state, new Date(nowIso));
    if (lastEvent) state.last_seen_event_id = lastEvent.event_id;
    writeCursorState(cursorPath, state);
    const cadence = computeCadence(state, lastEventAt, new Date(nowIso));
    const obligations = computeObligations(events, nowIso);

    // Delegate to tickDeterministic — this is where routing actually happens.
    // start returns the tick result so the harness knows what to do next.
    const tickResult = await tickDeterministic(slug, { workspaceId: workspaceId || 'unknown', triplet });
    console.log(JSON.stringify({
      action: 'loop-started',
      tick_result: tickResult,
      slug, triplet,
      cursor_path: cursorPath,
      recommended_sleep_ms: cadence.sleepMs,
      cadence_mode: cadence.mode,
      cadence_reason: cadence.reason,
      obligations,
      preflight_warnings: pf.warnings,
      note: 'Harness drives re-entry at recommended_sleep_ms. This command does not block-sleep.',
    }, null, 2));
    return 0;
  }

  if (sub === 'status') {
    const cadence = computeCadence(state, lastEventAt, new Date(nowIso));
    const obligations = computeObligations(events, nowIso);
    console.log(renderStatusBlock(events, slug, cadence, obligations));
    return 0;
  }

  if (sub === 'stop') {
    if (lastEvent) state.last_seen_event_id = lastEvent.event_id;
    state.fast_poll_window_expires_at = null; // clear fast-poll on stop
    writeCursorState(cursorPath, state);
    console.log(JSON.stringify({
      action: 'loop-stopped', slug,
      cursor_persisted: cursorPath,
      note: 'Cursor saved. Re-run "collab-loop start" to resume. Collab is NOT closed.',
    }, null, 2));
    return 0;
  }

  process.stderr.write(`unknown subcommand: ${sub}\n`);
  return 2;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => process.exit(code ?? 0));
}
