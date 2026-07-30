/**
 * collab-route.mjs — deterministic message → action discriminator (DC-77).
 *
 * Pure routing: takes a natural-language message and current collab state,
 * returns one of: kickoff | join | tick | status | abort | fuzzy.
 *
 * v0.2: transport-aware. Parser grammar per §6.2:
 *   message → [verb-prefix?] [transport-token?] <discourse-body>
 * State carries a byTransport dimension per §6.1; PINs remain flat per §6.3.
 *
 * CLI: node collab-route.mjs "<message>" [--workspace-id <id>]
 *   Scans both ~/.collab/local/ (localhost) and ~/Documents/Projects/<repo>/collabs/
 *   (github:<repo>) when run as CLI. Returns route + slug + transport as JSON on stdout.
 */
import { realpathSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readEvents, isClosed, hasJoined, deriveTriplet, findCollabDir, isPinRef } from './collab-event-helpers.mjs';
import { LOCAL_COLLABS_ROOT, GITHUB_REPOS_ROOT } from './transport.mjs';

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

// Discourse verbs are safe to strip during transport extraction; routing verbs
// (abort, cancel, status of) must remain in `rest` so detectAction's ABORT_RE /
// STATUS_RE checks still fire. We peek past routing verbs to find a trailing
// transport token, then prepend the routing verb back into `rest`.
const DISCOURSE_VERB_PREFIX_RE = /^(look at|talk about|discuss|review|join)\s+/i;
const ROUTING_VERB_PREFIX_RE = /^(abort|cancel|status of)\s+/i;
const TRANSPORT_TOKEN_RE = /^(localhost|github:[a-z0-9_-]+)\s+/i;

/**
 * extractTransport — peel off an optional leading discourse-verb prefix, then
 * (without consuming it) peek past any routing-verb prefix to detect a transport
 * token. Routing verbs are preserved in `rest` so detectAction can still route
 * abort/cancel/status correctly.
 *
 * Returns { transport, rest }.
 *
 * Examples:
 *   'localhost discuss memory'              → { transport: 'localhost', rest: 'discuss memory' }
 *   'github:files look at slug X'           → { transport: 'github:files', rest: 'look at slug X' }
 *   'look at localhost slug X'              → { transport: 'localhost', rest: 'slug X' }
 *   'abort localhost slug X'                → { transport: 'localhost', rest: 'abort slug X' }
 *   'status of github:files slug Y'         → { transport: 'github:files', rest: 'status of slug Y' }
 *   'discuss the architecture'              → { transport: null, rest: 'the architecture' }
 *   'localhost' (no trailing space)         → { transport: null, rest: 'localhost' }
 */
export function extractTransport(rawMessage) {
  const afterDiscourse = rawMessage.replace(DISCOURSE_VERB_PREFIX_RE, '');
  const routingMatch = afterDiscourse.match(ROUTING_VERB_PREFIX_RE);
  const routingPrefix = routingMatch ? routingMatch[0] : '';
  const afterRouting = routingPrefix ? afterDiscourse.slice(routingPrefix.length) : afterDiscourse;
  const m = afterRouting.match(TRANSPORT_TOKEN_RE);
  if (!m) return { transport: null, rest: afterDiscourse }; // routing verb (if any) stays in rest naturally
  return { transport: m[1].toLowerCase(), rest: routingPrefix + afterRouting.slice(m[0].length) };
}

export function extractSlug(message) {
  for (const re of SLUG_PATTERNS) {
    const m = message.match(re);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

// If the extracted ref is a 6-digit PIN, resolve it to a full slug via
// state.pinIndex (flat across transports per §6.3). Returns the resolved slug
// or the original ref if no match.
function resolvePinRef(ref, state) {
  if (!ref || !isPinRef(ref)) return ref;
  return state.pinIndex?.get(ref) || ref;
}

export function detectAction(message, state, explicitTransport) {
  const transport = explicitTransport || 'github:files';
  const view = (state.byTransport && state.byTransport[transport])
    || { existsActive: new Set(), existsClosed: new Set(), joined: new Set() };

  const rawSlug = extractSlug(message);
  const extractedSlug = resolvePinRef(rawSlug, state);

  if (ABORT_RE.test(message) && extractedSlug) {
    if (view.existsActive.has(extractedSlug)) {
      return { route: 'abort', slug: extractedSlug, transport };
    }
    return { route: 'fuzzy', extractedSlug, transport };
  }

  if (STATUS_RE.test(message) && extractedSlug) {
    if (view.existsActive.has(extractedSlug) || view.existsClosed.has(extractedSlug)) {
      return { route: 'status', slug: extractedSlug, transport };
    }
    return { route: 'fuzzy', extractedSlug, transport };
  }

  if (extractedSlug && view.existsActive.has(extractedSlug)) {
    if (view.joined.has(extractedSlug)) return { route: 'tick', slug: extractedSlug, transport };
    return { route: 'join', slug: extractedSlug, transport };
  }

  if (extractedSlug && !view.existsActive.has(extractedSlug) && !view.existsClosed.has(extractedSlug)) {
    return { route: 'fuzzy', extractedSlug, transport };
  }

  if (extractedSlug && view.existsClosed.has(extractedSlug)) {
    return { route: 'fuzzy', extractedSlug, transport };
  }

  return { route: 'kickoff', transport };
}

export function buildStateFromDisk(triplet) {
  const state = { byTransport: {}, pinIndex: new Map() };
  const transportsToScan = [];
  if (existsSync(LOCAL_COLLABS_ROOT)) {
    transportsToScan.push({ transport: 'localhost', root: LOCAL_COLLABS_ROOT });
  }
  if (existsSync(GITHUB_REPOS_ROOT)) {
    for (const e of readdirSync(GITHUB_REPOS_ROOT, { withFileTypes: true })) {
      const root = join(GITHUB_REPOS_ROOT, e.name, 'collabs');
      if (existsSync(root)) transportsToScan.push({ transport: `github:${e.name}`, root });
    }
  }
  for (const { transport, root } of transportsToScan) {
    const view = { existsActive: new Set(), existsClosed: new Set(), joined: new Set() };
    state.byTransport[transport] = view;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const slug = e.name.replace(/^\d{4}-\d{2}-\d{2}-/, '');
      const events = readEvents(join(root, e.name));
      const active = !isClosed(events);
      if (active) view.existsActive.add(slug); else view.existsClosed.add(slug);
      if (hasJoined(events, triplet)) view.joined.add(slug);
      // PIN index is flat across transports (PINs are globally unique like slugs).
      // Active collabs win on collision (vanishingly unlikely).
      const kickoff = events.find(ev => ev.type === 'kickoff');
      const pin = kickoff?.payload?.pin;
      if (pin && /^\d{6}$/.test(pin) && (active || !state.pinIndex.has(pin))) {
        state.pinIndex.set(pin, slug);
      }
    }
  }
  return state;
}

// For join routes, surface the kickoff's tick cadence so SKILL.md can show the
// right /loop command. Defaults to 30 when the kickoff didn't declare a cadence.
// Note: still uses the legacy single-transport findCollabDir scanner. Since slugs
// are unique across transports (T5 assertSlugUnique), this returns null for
// localhost-only collabs, which falls back to the 30-min default — acceptable.
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
  const { transport: explicitTransport, rest } = extractTransport(message);
  const triplet = deriveTriplet(workspaceId);
  const state = buildStateFromDisk(triplet);
  const result = detectAction(rest, state, explicitTransport);
  if (result.route === 'join' && result.slug) {
    result.tick_interval_minutes = tickIntervalMinutesFromKickoff(result.slug);
  }
  process.stdout.write(JSON.stringify({ ...result, triplet }) + '\n');
  return 0;
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) process.exit(main(process.argv.slice(2)));
