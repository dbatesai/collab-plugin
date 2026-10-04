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
import { writeFileSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER_DIR } from './collab-anchor.mjs';
import {
  deriveSlug, appendEvent, renderEventsJsonl,
  resolveIdentity, gitPullRebase, deliverChannel, recordOwnedArtifact, generatePin,
  assertSlugUnique, generateEventId, authorSlugFromTriplet,
  PLACEHOLDER_MEASURE_RE, validateMeasures,
} from './collab-event-helpers.mjs';
import {
  parseTransport, isGitTransport, resolveTransportPaths,
  defaultTickIntervalMinutes, defaultRatificationWindowMinutes, preflightTransport,
} from './transport.mjs';

// The measure validator lives with the other ledger semantics; re-exported so the CLI's
// callers keep one import.
export { PLACEHOLDER_MEASURE_RE, validateMeasures };

/** `--measure "<id>|<description>|<participant-triplet>"` → measure object; throws on malformed input. */
export function parseMeasureFlag(value) {
  const parts = String(value ?? '').split('|').map(s => s.trim());
  if (parts.length !== 3 || parts.some(p => !p)) {
    throw new Error('--measure needs "<id>|<description>|<participant-triplet>" with all three parts non-empty');
  }
  return { id: parts[0], description: parts[1], requires_review_from: parts[2] };
}

export function buildKickoffPayload(message, igm, capabilitiesWanted, wallClockHours = 24, tickIntervalMinutes, pin, opts = {}) {
  const payload = { message, igm, capabilities_wanted: capabilitiesWanted, wall_clock_hours: wallClockHours };
  if (typeof tickIntervalMinutes === 'number') payload.tick_interval_minutes = tickIntervalMinutes;
  if (typeof pin === 'string' && /^\d{6}$/.test(pin)) payload.pin = pin;
  if (typeof opts.transport === 'string') payload.transport = opts.transport;
  if (typeof opts.ratificationWindowMinutes === 'number') payload.ratification_window_minutes = opts.ratificationWindowMinutes;
  if (typeof opts.minCollabPluginVersion === 'string') payload.min_collab_plugin_version = opts.minCollabPluginVersion;

  const generated = (Array.isArray(opts.requiredReviews) ? opts.requiredReviews : []).map(t => ({
    id: `independent-review-${authorSlugFromTriplet(t)}`,
    description: `independent review by ${t}`,
    requires_review_from: t,
  }));
  const measures = [...generated, ...(Array.isArray(opts.measures) ? opts.measures : [])];

  // Writer gate: a non-solo session (capabilities wanted) must declare its contract.
  if (capabilitiesWanted.length && measures.length === 0) {
    throw new Error('completion-measures-required: a kickoff that wants other participants must declare at least one measure (--measure or --required-review)');
  }
  const errors = validateMeasures(measures);
  if (errors.length) throw new Error(errors.join('; '));
  if (measures.length) payload.ratified_completion_measures = measures;
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
    measures = [],
  } = options;

  if (!parseTransport(transport)) throw new Error(`invalid transport: ${transport}`);

  const slug = deriveSlug(message);

  // Order is load-bearing: collision check before any side effects (preflight, git, mkdir).
  // Runs on dry runs too: a dry run still writes the kickoff locally, and without the check it
  // appends into a live same-day collab of the same slug.
  assertSlugUnique(slug);

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
  // A localhost collab is anchored from its first event: the order log decides what precedes the
  // first close (collab-anchor.mjs). Git collabs are ordered by the remote's commit history.
  if (parseTransport(transport).kind === 'localhost') mkdirSync(join(collabDir, ORDER_DIR), { recursive: true });
  const kickoffMd = buildKickoffMd(slug, message, igm, capabilitiesWanted, triplet);
  writeFileSync(join(collabDir, 'KICKOFF.md'), kickoffMd);
  recordOwnedArtifact(collabDir, triplet, 'KICKOFF.md', kickoffMd);

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
      measures,
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
  recordOwnedArtifact(collabDir, triplet, 'events.jsonl', readFileSync(join(collabDir, 'events.jsonl')));

  if (!dryRun && isGitTransport(transport)) {
    deliverChannel(collabDir, transport, triplet, `[${triplet}] kickoff: ${slug} ${kickoffEvtId}`);
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
  const measures = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (argv[i] === '--measure') {
      try { measures.push(parseMeasureFlag(argv[++i])); }
      catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
    }
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
    transport, ratificationWindowMinutes, minCollabPluginVersion, requiredReviews, measures,
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
