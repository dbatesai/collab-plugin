/**
 * collab-render.mjs — render STATUS.md and turns/*.md from events.jsonl.
 * Idempotent. Commits + pushes after render.
 * CLI: node collab-render.mjs <slug>
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  findCollabDir, readEvents, getJoinedAgents,
  findActiveProposeClose, getRatificationStatus,
  checkSafetyNets, deliverChannel, recordOwnedArtifact, readDeliveryManifest, isRecordedArtifact, gitBlobHash, gitUpstreamBlobs, gitBlobText,
  gitUpstreamJsonl, EVENT_SOURCE, eventFilenameViolations,
  authorSlugFromTriplet, reconcileForeignSurface,
  renderEventsJsonl, measureVerdicts, openRequests,
  STALL_TICKS, TICK_INTERVAL_MS,
} from './collab-event-helpers.mjs';
import { isGitTransport } from './transport.mjs';

export function buildStatusMd(events, slug) {
  const kickoff = events.find(e => e.type === 'kickoff');
  const closeEvt = events.find(e => e.type === 'close');
  const joined = getJoinedAgents(events);
  const proposeClose = findActiveProposeClose(events);
  const ratStatus = getRatificationStatus(events);

  let state = 'active';
  if (closeEvt) state = `closed — ${closeEvt.payload.outcome}`;
  else if (proposeClose) state = 'propose-close-pending';

  const lines = [`# STATUS — ${slug}`, '', `## Current state: ${state}`, ''];

  // A close with a contract receipt says what arrived, what was objected to, what never came.
  const cp = closeEvt?.payload;
  if (cp && Array.isArray(cp.unmet_ratified_measures)) {
    const idsOf = (l) => (l || []).map(m => m.id).join(', ') || 'none';
    lines.push(`Ratified: ${idsOf(cp.ratified_measures)}`, `Objected: ${idsOf(cp.objected_measures)}`,
      `Unmet: ${idsOf(cp.unmet_ratified_measures)}`, `Missing reviews from: ${(cp.missing_reviews_from || []).join(', ') || 'none'}`);
    if (cp.note) lines.push('', cp.note);
    lines.push('');
  }

  if (kickoff?.payload?.igm) {
    const { intention, goal, measure } = kickoff.payload.igm;
    lines.push('## IGM', `**Intention:** ${intention}`, `**Goal:** ${goal}`, `**Measure:** ${measure}`, '');
  }

  lines.push('## Participants');
  if (joined.length === 0) { lines.push('*(none joined yet)*'); }
  else {
    lines.push('| Agent | Last event |', '|---|---|');
    for (const a of joined) {
      const last = [...events].reverse().find(e => e.author === a);
      lines.push(`| ${a} | ${last?.ts ?? '—'} |`);
    }
  }
  lines.push('');

  // Declared measures and how each credit was read: `scoped` names the ids it judges,
  // `legacy` is a bare verdict from the named reviewer read author-wide, as 1.1.0 did.
  const verdicts = measureVerdicts(events);
  if (verdicts.size) {
    lines.push('## Measures', '| Measure | Reviewer | State | Scope | Note |', '|---|---|---|---|---|');
    for (const v of verdicts.values()) {
      const o = v.objected[0], r = v.ratified[0];
      const [st, scope, note] = o ? ['objected', o.scope, o.reason || ''] : r ? ['ratified', r.scope, ''] : ['unmet', '—', ''];
      lines.push(`| ${v.measure.id} | ${v.measure.requires_review_from} | ${st} | ${scope} | ${note} |`);
    }
    lines.push('');
  }

  // Open requests, by recipient: who is waiting on whom, since when, until when, and the
  // requester's fallback when the deadline passes.
  const waiting = joined.flatMap(a => openRequests(events, a));
  if (waiting.length) {
    lines.push('## Waiting', '| Request | Who → whom | Since | Deadline | Fallback | State |', '|---|---|---|---|---|---|');
    for (const r of waiting) lines.push(`| ${r.request_id} | ${r.from} → ${r.to} | ${r.ts} | ${r.deadline} | ${r.on_timeout} | ${r.state} |`);
    lines.push('');
  }

  lines.push('## Recent activity (last 5)');
  for (const e of events.slice(-5).reverse()) lines.push(`- **${e.ts}** [${e.type}] ${e.author}`);
  lines.push('');

  if (proposeClose && ratStatus) {
    const required = new Set(ratStatus.requiredReviewers || []);
    const silenceRatifies = ratStatus.pending.filter(a => !required.has(a));
    const owedReviews = ratStatus.pending.filter(a => required.has(a));
    lines.push('## Propose-close status',
      `Proposed by: ${proposeClose.author}`,
      `Ratified: ${ratStatus.ratified.join(', ') || 'none'}`,
      `Pending (silence = ratify): ${silenceRatifies.join(', ') || 'none'}`);
    if (owedReviews.length) {
      lines.push(`Owed — silence does NOT ratify (their review is a ratified measure): ${owedReviews.join(', ')}`);
    }
    lines.push('');
  }

  const now = new Date().toISOString();
  if (kickoff) {
    const wallH = kickoff.payload.wall_clock_hours ?? 24;
    const elH = ((new Date(now) - new Date(kickoff.ts)) / 3600000).toFixed(1);
    const stallMin = ((new Date(now) - new Date(events[events.length-1].ts)) / 60000).toFixed(0);
    lines.push('## Safety nets',
      `Wall-clock: ${elH}h / ${wallH}h`,
      `Stall: ${stallMin}min since last event / ${STALL_TICKS * TICK_INTERVAL_MS / 60000}min limit`, '');
  }

  return lines.join('\n');
}

export function buildTurnMd(event) {
  const parts = [
    `# Turn — ${event.event_id}`, '',
    `**Author:** ${event.author}`, `**Timestamp:** ${event.ts}`,
  ];
  if (event.payload.intent) parts.push(`**Intent:** ${event.payload.intent}`);
  if (event.payload.signals?.length) parts.push(`**Signals:** ${event.payload.signals.join(', ')}`);
  parts.push('', event.payload.body || event.payload.synthesis || event.payload.reason || '');
  return parts.join('\n');
}

export async function render(slug, options = {}) {
  const { collabDir, author, dryRun = false, publish = true } = options;
  const dir = collabDir || findCollabDir(slug);
  if (!dir) throw new Error(`no collab directory: ${slug}`);
  // Rendering is output. A file under events/ not named for its event is a hard stop here as
  // everywhere: nothing is reconciled, written, recorded, or published while one is present.
  const violations = eventFilenameViolations(dir);
  if (violations.length) return { refused: { reason: 'event-filename-violation', paths: violations }, blocked: null, conflicts: [], delivery: null };

  // Import anything a legacy JSONL-only writer left in events.jsonl BEFORE rendering over
  // it. Rendering rebuilds that file from events/, so an unimported peer event would be
  // destroyed with no error — that is how a peer's turn was lost in this project (D5).
  // Automatic and recorded: reconcile emits a `reconciled` event naming what it imported.
  const rec = reconcileForeignSurface(dir, author);
  if (rec.imported.length > 0 || rec.escalated.length > 0) {
    process.stderr.write(
      `(reconcile) imported ${rec.imported.length} foreign event(s)` +
      (rec.escalated.length ? `, escalated ${rec.escalated.length}: ${JSON.stringify(rec.escalated)}` : '') + '\n',
    );
  }

  const all = readEvents(dir);
  const transport = options.transport || all.find(e => e.type === 'kickoff')?.payload?.transport || 'github:files';

  // Ownership is an end-to-end constraint, not a publisher gate. On a git transport the
  // renders are derived only from events this participant may publish — its own, and those
  // the upstream already holds — so an unpublished foreign event never travels through a
  // derived file; and an existing file is replaced only when it is a render this participant
  // recorded or the bytes the upstream holds, so unknown bytes are preserved and reported.
  const bounded = Boolean(author) && isGitTransport(transport);
  const upstream = bounded ? gitUpstreamBlobs(dir, transport) : new Map();
  const manifest = author ? readDeliveryManifest(dir, author) : {};
  // An input is publishable by the exact bytes that were parsed: the reader binds each event
  // to its source file and that file's blob id in the same read, so the evidence is of the
  // bytes in hand — never of a file re-read by an id-derived path. An event whose file the
  // upstream holds counts only if that blob is the published one (an edit to published
  // history is not an input, whoever wrote it — author equality does not authorize
  // rewriting). An event published only as a line of the upstream's events.jsonl (a legacy
  // writer) counts if it is that line, canonically. Anything else counts only if this
  // participant wrote it.
  // One published identity may have two representations — an upstream event file, an upstream
  // events.jsonl line — and a local file may contradict either. A contradiction is a conflict:
  // the render derives from the PUBLISHED representation, so published content is never erased
  // and local edits never travel; the local bytes stay on disk and the conflict is reported.
  const upstreamJsonl = bounded ? gitUpstreamJsonl(dir, transport, upstream) : new Map();
  const conflicts = [];
  const resolve = (e) => {                        // → the event to render from, or null to exclude
    if (!bounded) return e;
    const src = e[EVENT_SOURCE];
    if (!src) return null;
    if (src.hash && upstream.has(src.path)) {
      if (src.hash === upstream.get(src.path)) return e;
      conflicts.push({ event_id: e.event_id, path: src.path, reason: 'local file differs from the published file' });
      try { return JSON.parse(gitBlobText(transport, upstream.get(src.path))); } catch { return null; }
    }
    const line = upstreamJsonl.get(e.event_id);
    if (line) {
      if (line.canonical === JSON.stringify(e)) return e;
      conflicts.push({ event_id: e.event_id, path: src.path, reason: 'local file differs from the published events.jsonl line' });
      return line.event;
    }
    return e.author === author ? e : null;
  };
  const events = all.map(resolve).filter(Boolean);
  // Published events with no local representation at all (a legacy line reconcile did not
  // import, a file deleted locally) still belong in the derived files.
  const have = new Set(events.map(e => e.event_id));
  for (const [id, { event }] of upstreamJsonl) if (!have.has(id)) { events.push(event); have.add(id); }
  events.sort((x, y) => (x.ts !== y.ts ? (x.ts < y.ts ? -1 : 1) : (x.event_id < y.event_id ? -1 : 1)));
  const publishable = (e) => have.has(e.event_id) && events.some(x => x.event_id === e.event_id && JSON.stringify(x) === JSON.stringify(e));
  const preserved = [];
  const mayReplace = (relPath) => {
    const p = join(dir, relPath);
    if (!bounded || !existsSync(p)) return true;
    const h = gitBlobHash(readFileSync(p));
    return isRecordedArtifact(manifest, relPath, h) || upstream.get(relPath) === h;
  };
  const put = (relPath, content) => {
    if (!mayReplace(relPath)) { preserved.push(relPath); return; }
    writeFileSync(join(dir, relPath), content);
    if (author) recordOwnedArtifact(dir, author, relPath, content);
  };
  put('STATUS.md', buildStatusMd(events, slug));

  const turnsDir = join(dir, 'turns');
  if (!existsSync(turnsDir)) mkdirSync(turnsDir);
  for (const e of events.filter(e => e.type === 'turn')) {
    const idSuffix = e.event_id.replace(/^evt-/, '');
    put(join('turns', `${idSuffix}-${authorSlugFromTriplet(e.author)}.md`), buildTurnMd(e));
  }

  if (mayReplace('events.jsonl')) {
    const content = renderEventsJsonl(dir, { events: bounded ? events : undefined, include: publishable });
    if (author) recordOwnedArtifact(dir, author, 'events.jsonl', content);
  } else preserved.push('events.jsonl');

  const blocked = preserved.length ? { reason: 'unrecorded-existing-files', paths: preserved } : null;
  if (!dryRun && publish && author && isGitTransport(transport)) {
    const last = events[events.length - 1];
    return { blocked, conflicts, delivery: deliverChannel(dir, transport, author, `[${author}] render: ${slug} ${last?.event_id ?? 'init'}`) };
  }
  return { blocked, conflicts, delivery: null };
}

export function main(argv) {
  const slug = argv[0];
  if (!slug) { process.stderr.write('usage: collab-render.mjs <slug>\n'); return 2; }
  render(slug).then(() => process.stdout.write(`Rendered STATUS.md + turns/ for ${slug}\n`))
    .catch(e => { process.stderr.write(`render error: ${e.message}\n`); process.exit(1); });
}

const _c = p => { try { return realpathSync(p); } catch { return p; } };
if (_c(process.argv[1]) === _c(fileURLToPath(import.meta.url))) main(process.argv.slice(2));
