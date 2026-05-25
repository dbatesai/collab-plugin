/**
 * collab-kickoff.mjs — kickoff a new collaboration.
 * Derives slug + IGM, writes KICKOFF.md + events.jsonl (kickoff + self-join), commits + pushes.
 * CLI: node collab-kickoff.mjs "<message>" --workspace-id <id> [--dry-run]
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  deriveSlug, createCollabDir, nextEventId, appendEvent,
  deriveTriplet, gitPullRebase, gitCommitPush, generatePin,
} from './collab-event-helpers.mjs';

export function buildKickoffPayload(message, igm, capabilitiesWanted, wallClockHours = 24, tickIntervalMinutes, pin) {
  const payload = { message, igm, capabilities_wanted: capabilitiesWanted, wall_clock_hours: wallClockHours };
  if (typeof tickIntervalMinutes === 'number') payload.tick_interval_minutes = tickIntervalMinutes;
  if (typeof pin === 'string' && /^\d{6}$/.test(pin)) payload.pin = pin;
  return payload;
}

export function buildSelfJoinPayload(capabilityMatch, commitment) {
  return { capability_match: capabilityMatch, commitment };
}

export function deriveIGM(message) {
  return {
    intention: `Understand and address: ${message}`,
    goal: `Produce a concrete outcome from: ${message}`,
    measure: "(measure inferred as 'reasonable consensus on goal'; refine in first turn)",
  };
}

export function buildKickoffMd(slug, message, igm, capabilitiesWanted, author) {
  return [
    `# KICKOFF — ${slug}`, '', `**Originator:** ${author}`, `**Message:** ${message}`, '',
    '## IGM', `**Intention:** ${igm.intention}`, `**Goal:** ${igm.goal}`, `**Measure:** ${igm.measure}`, '',
    '## Capabilities wanted',
    capabilitiesWanted.length ? capabilitiesWanted.map(c => `- ${c}`).join('\n') : '*(none specified)*',
    '', '---', '_Written once at kickoff; never modified._',
  ].join('\n');
}

export async function kickoff(message, options = {}) {
  const { workspaceId = 'unknown', dryRun = false, wallClockHours = 24, capabilitiesWanted = [], tickIntervalMinutes, pin } = options;
  if (!dryRun) gitPullRebase();

  const slug = deriveSlug(message);
  const igm = deriveIGM(message);
  const triplet = deriveTriplet(workspaceId);
  const nowTs = new Date().toISOString();
  const collabPin = pin || generatePin();
  const dir = createCollabDir(slug);

  writeFileSync(join(dir, 'KICKOFF.md'), buildKickoffMd(slug, message, igm, capabilitiesWanted, triplet));

  const kickoffEvt = { event_id:'evt-001', ts:nowTs, author:triplet, slug, type:'kickoff', references:[],
    payload: buildKickoffPayload(message, igm, capabilitiesWanted, wallClockHours, tickIntervalMinutes, collabPin) };
  appendEvent(dir, kickoffEvt);

  const joinEvt = { event_id:'evt-002', ts:nowTs, author:triplet, slug, type:'join', references:['evt-001'],
    payload: buildSelfJoinPayload([], 'Originator; self-joined at kickoff') };
  appendEvent(dir, joinEvt);

  if (!dryRun) gitCommitPush(dir, `[${triplet}] kickoff: ${slug} evt-001`);
  return { slug, triplet, dir, kickoffEvt, joinEvt, pin: collabPin };
}

export function main(argv) {
  let message = null, workspaceId = null, dryRun = false, tickIntervalMinutes, pin;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--tick-interval-minutes') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0 || n > 1440) {
        process.stderr.write('--tick-interval-minutes must be a positive number, 1–1440\n');
        return 2;
      }
      tickIntervalMinutes = n;
    }
    else if (argv[i] === '--pin') {
      pin = argv[++i];
      if (!/^\d{6}$/.test(pin)) {
        process.stderr.write('--pin must be a 6-digit string\n');
        return 2;
      }
    }
    else if (!argv[i].startsWith('--')) message = argv[i];
  }
  if (!message) { process.stderr.write('usage: collab-kickoff.mjs "<message>" [--workspace-id <id>] [--tick-interval-minutes <n>] [--pin <6-digits>] [--dry-run]\n'); return 2; }
  kickoff(message, { workspaceId, dryRun, tickIntervalMinutes, pin })
    .then(r => {
      const cadenceMin = tickIntervalMinutes ?? 30;
      process.stdout.write(`Kickoff: ${r.slug}\nPIN: ${r.pin}  (your manual-entry shorthand; agents still use the slug)\nStart: /loop ${cadenceMin}m /collab "look at slug ${r.slug}"\nOr (your shorthand): /collab ${r.pin}\n`);
    })
    .catch(e => { process.stderr.write(`kickoff error: ${e.message}\n`); process.exit(1); });
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
