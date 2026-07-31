/**
 * collab-kickoff.mjs — kickoff a new collaboration.
 * Derives slug + IGM, writes KICKOFF.md + events (kickoff + self-join), commits + pushes
 * (when transport is git-mediated). Transport-aware (v0.2): supports localhost and github:<repo>.
 *
 * CLI: node collab-kickoff.mjs "<message>" --workspace-id <id> [--dry-run]
 *      [--transport <id>] [--tick-interval-minutes <n>] [--pin <6-digits>]
 *      [--ratification-window-minutes <n>] [--min-version <semver>]
 *      [--required-review <participant-triplet>]   (repeatable)
 */
import { writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  deriveSlug, appendEvent, renderEventsJsonl,
  resolveIdentity, gitPullRebase, gitCommitPush, generatePin,
  assertSlugUnique, generateEventId, authorSlugFromTriplet,
} from './collab-event-helpers.mjs';
import {
  parseTransport, isGitTransport, resolveTransportPaths,
  defaultTickIntervalMinutes, defaultRatificationWindowMinutes, preflightTransport,
} from './transport.mjs';

export function buildKickoffPayload(message, igm, capabilitiesWanted, wallClockHours = 24, tickIntervalMinutes, pin, opts = {}) {
  const payload = { message, igm, capabilities_wanted: capabilitiesWanted, wall_clock_hours: wallClockHours };
  if (typeof tickIntervalMinutes === 'number') payload.tick_interval_minutes = tickIntervalMinutes;
  if (typeof pin === 'string' && /^\d{6}$/.test(pin)) payload.pin = pin;
  if (typeof opts.transport === 'string') payload.transport = opts.transport;
  if (typeof opts.ratificationWindowMinutes === 'number') payload.ratification_window_minutes = opts.ratificationWindowMinutes;
  if (typeof opts.minCollabPluginVersion === 'string') payload.min_collab_plugin_version = opts.minCollabPluginVersion;
  if (Array.isArray(opts.requiredReviews) && opts.requiredReviews.length) {
    payload.ratified_completion_measures = opts.requiredReviews.map(t => ({
      id: `independent-review-${authorSlugFromTriplet(t)}`,
      description: `independent review by ${t}`,
      requires_review_from: t,
    }));
  }
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
  const {
    workspaceId = 'unknown',
    dryRun = false,
    wallClockHours = 24,
    capabilitiesWanted = [],
    tickIntervalMinutes,
    pin,
    transport = 'github:files',
    ratificationWindowMinutes,
    minCollabPluginVersion = '0.2.0',
    requiredReviews = [],
  } = options;

  if (!parseTransport(transport)) throw new Error(`invalid transport: ${transport}`);

  const slug = deriveSlug(message);

  // Order is load-bearing: collision check before any side effects (preflight, git, mkdir).
  if (!dryRun) assertSlugUnique(slug);

  const date = new Date().toISOString().slice(0, 10);
  const dirName = `${date}-${slug}`;

  if (!dryRun) {
    const pf = preflightTransport(transport);
    if (!pf.ok) throw new Error(`preflight failed: ${pf.error}`);
  }

  if (!dryRun && isGitTransport(transport)) gitPullRebase(transport);

  const igm = deriveIGM(message);
  // Mints the participant on first use and reads the persisted record after. `harness` is
  // read fresh and travels beside the identity on each event, never inside it.
  const identity = resolveIdentity(workspaceId);
  const triplet = identity.triplet;
  const nowTs = new Date().toISOString();
  const collabPin = pin || generatePin();
  const tickMin = typeof tickIntervalMinutes === 'number'
    ? tickIntervalMinutes
    : defaultTickIntervalMinutes(transport);
  const ratMin = typeof ratificationWindowMinutes === 'number'
    ? ratificationWindowMinutes
    : defaultRatificationWindowMinutes(transport, tickMin);

  const { collabDir, turnsDir } = resolveTransportPaths(transport, dirName);
  mkdirSync(turnsDir, { recursive: true });
  writeFileSync(join(collabDir, 'KICKOFF.md'), buildKickoffMd(slug, message, igm, capabilitiesWanted, triplet));

  const authorSlug = authorSlugFromTriplet(triplet);
  const kickoffEvtId = generateEventId(nowTs, authorSlug);
  const kickoffEvt = {
    event_id: kickoffEvtId,
    ts: nowTs,
    author: triplet,
    participant_id: identity.participant_id,
    harness: identity.harness,
    slug,
    type: 'kickoff',
    references: [],
    payload: buildKickoffPayload(message, igm, capabilitiesWanted, wallClockHours, tickMin, collabPin, {
      transport,
      ratificationWindowMinutes: ratMin,
      minCollabPluginVersion,
      requiredReviews,
    }),
  };
  appendEvent(collabDir, kickoffEvt);

  // Bump the self-join timestamp by 1ms so readEvents sorts kickoff first
  // even when their random event_id suffixes happen to sort the join earlier.
  const joinTs = new Date(new Date(nowTs).getTime() + 1).toISOString();
  const joinEvt = {
    event_id: generateEventId(joinTs, authorSlug),
    ts: joinTs,
    author: triplet,
    participant_id: identity.participant_id,
    harness: identity.harness,
    slug,
    type: 'join',
    references: [kickoffEvtId],
    payload: buildSelfJoinPayload([], 'Originator; self-joined at kickoff'),
  };
  appendEvent(collabDir, joinEvt);

  renderEventsJsonl(collabDir);

  if (!dryRun && isGitTransport(transport)) {
    gitCommitPush(collabDir, transport, `[${triplet}] kickoff: ${slug} ${kickoffEvtId}`);
  }

  return {
    slug, triplet, participantId: identity.participant_id, harness: identity.harness,
    dir: collabDir, transport,
    tickIntervalMinutes: tickMin, ratificationWindowMinutes: ratMin,
    kickoffEvt, joinEvt, pin: collabPin,
  };
}

export function main(argv) {
  let message = null, workspaceId = null, dryRun = false;
  let tickIntervalMinutes, pin, transport, ratificationWindowMinutes, minCollabPluginVersion;
  const requiredReviews = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--dry-run') dryRun = true;
    else if (argv[i] === '--transport') transport = argv[++i];
    else if (argv[i] === '--tick-interval-minutes') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0 || n > 1440) {
        process.stderr.write('--tick-interval-minutes must be a positive number, 1–1440\n');
        return 2;
      }
      tickIntervalMinutes = n;
    }
    else if (argv[i] === '--ratification-window-minutes') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0 || n > 1440) {
        process.stderr.write('--ratification-window-minutes must be a positive number, 1–1440\n');
        return 2;
      }
      ratificationWindowMinutes = n;
    }
    else if (argv[i] === '--required-review') {
      const t = argv[++i];
      if (!t || t.startsWith('--')) {
        process.stderr.write('--required-review needs a participant triplet like core-gemini@antigravity:host\n');
        return 2;
      }
      requiredReviews.push(t);
    }
    else if (argv[i] === '--min-version') {
      minCollabPluginVersion = argv[++i];
      if (!/^\d+\.\d+\.\d+$/.test(minCollabPluginVersion)) {
        process.stderr.write('--min-version must be a semver string like 0.2.0\n');
        return 2;
      }
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
  if (!message) {
    process.stderr.write('usage: collab-kickoff.mjs "<message>" [--workspace-id <id>] [--transport <id>] [--tick-interval-minutes <n>] [--ratification-window-minutes <n>] [--min-version <semver>] [--pin <6-digits>] [--dry-run]\n');
    return 2;
  }
  kickoff(message, {
    workspaceId, dryRun, tickIntervalMinutes, pin,
    transport, ratificationWindowMinutes, minCollabPluginVersion, requiredReviews,
  })
    .then(r => {
      process.stdout.write(
        `Kickoff: ${r.slug}\n` +
        `Transport: ${r.transport}\n` +
        `Tick interval: ${r.tickIntervalMinutes}m\n` +
        `Ratification window: ${r.ratificationWindowMinutes}m\n` +
        `PIN: ${r.pin}  (your manual-entry shorthand; agents still use the slug)\n` +
        `Start: /loop ${r.tickIntervalMinutes}m /collab "look at slug ${r.slug}"\n` +
        `Or (your shorthand): /collab ${r.pin}\n`,
      );
    })
    .catch(e => { process.stderr.write(`kickoff error: ${e.message}\n`); process.exit(1); });
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
