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
import { COLLABS_DIR, readEvents, isClosed, hasJoined, deriveTriplet } from './collab-event-helpers.mjs';

const SLUG_PATTERNS = [
  /\bslug\s+([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\blook at(?:\s+slug)?\s+([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\babort\s+(?:slug\s+)?([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\bcancel\s+(?:slug\s+)?([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\bstatus\s+(?:of\s+)?([a-z0-9][a-z0-9-]{0,49})\b/i,
  /\bhappening with\s+([a-z0-9][a-z0-9-]{0,49})\b/i,
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

export function detectAction(message, state) {
  const extractedSlug = extractSlug(message);

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
  const state = { existsActive: new Set(), existsClosed: new Set(), joined: new Set() };
  if (!existsSync(COLLABS_DIR)) return state;
  for (const e of readdirSync(COLLABS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const slug = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
    const events = readEvents(join(COLLABS_DIR, e.name));
    if (isClosed(events)) state.existsClosed.add(slug);
    else state.existsActive.add(slug);
    if (hasJoined(events, triplet)) state.joined.add(slug);
  }
  return state;
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
  process.stdout.write(JSON.stringify({ ...result, triplet }) + '\n');
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
