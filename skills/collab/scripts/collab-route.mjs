/**
 * collab-route.mjs — deterministic message → action discriminator (DC-77).
 *
 * Pure routing: takes a natural-language message and current collab state,
 * returns one of: kickoff | join | tick | status | abort | fuzzy.
 *
 * CLI: node collab-route.mjs "<message>" [--workspace-id <id>]
 *   Reads ~/Documents/Projects/files/collabs/ for state automatically when run as CLI.
 *   Returns route + slug as JSON on stdout.
 */
import { realpathSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { COLLABS_DIR, readEvents, isClosed, hasJoined, deriveTriplet, findCollabDir, isPinRef } from './collab-event-helpers.mjs';

const SLUG_PATTERNS = [
  /\bslug\s+([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\blook at(?:\s+slug)?\s+([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\babort\s+(?:slug\s+)?([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\bcancel\s+(?:slug\s+)?([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\bstatus\s+(?:of\s+)?([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\bhappening with\s+([a-z0-9][a-z0-9-]{0,49})\b/i,
  /(?:^|\s)(\d{6})(?:\s|$)/, // bare PIN — David's manual-entry shorthand
];

const ABORT_RE = /\b(abort|cancel)\b/i;
const STATUS_RE = /\b(status|happening|what'?s\s+happening|how is)\b/i;

export function extractSlug(message) {
  for (const re of SLUG_PATTERNS) {
    const m = message.match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// If the extracted ref is a 6-digit PIN, resolve it to a full slug via
// state.pinIndex. Returns the resolved slug or the original ref if no match.
function resolvePinRef(ref, state) {
  if (!ref || !isPinRef(ref)) return ref;
  return state.pinIndex?.get(ref) || ref;
}

export function detectAction(message, state) {
  const rawSlug = extractSlug(message);
  const extractedSlug = resolvePinRef(rawSlug, state);

  if (ABORT_RE.test(message) && extractedSlug) {
    if (state.existsActive.has(extractedSlug)) {
      return { route: 'abort', slug: extractedSlug };
    }
    return { route: 'fuzzy', extractedSlug };
  }

  if (STATUS_RE.test(message) && extractedSlug) {
    if (state.existsActive.has(extractedSlug) || state.existsClosed.has(extractedSlug)) {
      return { route: 'status', slug: extractedSlug };
    }
    return { route: 'fuzzy', extractedSlug };
  }

  if (extractedSlug && state.existsActive.has(extractedSlug)) {
    if (state.joined.has(extractedSlug)) return { route: 'tick', slug: extractedSlug };
    return { route: 'join', slug: extractedSlug };
  }

  if (extractedSlug && !state.existsActive.has(extractedSlug) && !state.existsClosed.has(extractedSlug)) {
    return { route: 'fuzzy', extractedSlug };
  }

  if (extractedSlug && state.existsClosed.has(extractedSlug)) {
    return { route: 'fuzzy', extractedSlug };
  }

  return { route: 'kickoff' };
}

export function buildStateFromDisk(triplet) {
  const state = { existsActive: new Set(), existsClosed: new Set(), joined: new Set(), pinIndex: new Map() };
  if (!existsSync(COLLABS_DIR)) return state;
  for (const e of readdirSync(COLLABS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const slug = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const events = readEvents(join(COLLABS_DIR, e.name));
    const active = !isClosed(events);
    if (active) state.existsActive.add(slug); else state.existsClosed.add(slug);
    if (hasJoined(events, triplet)) state.joined.add(slug);
    // PIN index: active collabs win on collision (vanishingly unlikely).
    const kickoff = events.find(ev => ev.type === 'kickoff');
    const pin = kickoff?.payload?.pin;
    if (pin && /^\d{6}$/.test(pin) && (active || !state.pinIndex.has(pin))) {
      state.pinIndex.set(pin, slug);
    }
  }
  return state;
}

// For join routes, surface the kickoff's tick cadence so SKILL.md can show the
// right /loop command. Defaults to 30 when the kickoff didn't declare a cadence.
export function tickIntervalMinutesFromKickoff(slug) {
  const dir = findCollabDir(slug);
  if (!dir) return 30;
  const events = readEvents(dir);
  const kickoff = events.find(e => e.type === 'kickoff');
  const minutes = kickoff?.payload?.tick_interval_minutes;
  return (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) ? minutes : 30;
}

export function main(argv) {
  let message = null, workspaceId = 'unknown';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--workspace-id') workspaceId = argv[++i];
    else if (!argv[i].startsWith('--') && message === null) message = argv[i];
  }
  if (!message) { process.stderr.write('usage: collab-route.mjs "<message>" [--workspace-id <id>]\n'); return 2; }
  const triplet = deriveTriplet(workspaceId);
  const state = buildStateFromDisk(triplet);
  const result = detectAction(message, state);
  if (result.route === 'join' && result.slug) {
    result.tick_interval_minutes = tickIntervalMinutesFromKickoff(result.slug);
  }
  process.stdout.write(JSON.stringify({ ...result, triplet }) + '\n');
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
