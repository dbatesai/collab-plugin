/**
 * collab-identity.mjs — persistent participant identity.
 *
 * A participant is minted once and persists. Before this module identity WAS the triplet
 * `workspace@harness:machine`, recomputed from environment sniffing on every call, so an
 * agent that lost its harness env var did not get a degraded label — it got a different
 * name, and walked out of its own channel. That is the `core-gemini@claude-code` mislabel.
 *
 * So:
 *   - `participant_id` is the identity. Minted once, persisted, carried on every event.
 *   - `triplet` is the display name, frozen at mint. It still reads
 *     `workspace@harness:machine` because every existing ledger, cursor, and required-review
 *     entry is written in that alphabet, but the harness inside it is a fossil of mint time,
 *     not a live reading.
 *   - `harness` is advisory. It sits BESIDE identity on each event, is read fresh every
 *     time, and is free to move or degrade to whatever `detectHarness()` reports.
 *
 * Store: <identityRoot()>/<workspace-id>.json — machine-local, one record per workspace.
 * The default root is ~/.collab/identity, a sibling of ~/.collab/local, and follows
 * COLLAB_LOCAL_ROOT so a test fixture never touches the real store.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, basename } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { detectHarness, localCollabsRoot } from './transport.mjs';

/** Where identity records live. Sibling of the localhost collab root, so fixtures follow. */
export function identityRoot() {
  if (process.env.COLLAB_IDENTITY_ROOT) return resolve(process.env.COLLAB_IDENTITY_ROOT);
  return join(dirname(localCollabsRoot()), 'identity');
}

/**
 * Short hostname. `hostname -s` is unsupported on Windows; the no-args form works on all
 * three OSes. Same derivation the pre-identity `deriveTriplet` used, kept byte-for-byte so
 * an install upgrading into this module mints the machine component it already had.
 */
export function deriveMachine() {
  let r = spawnSync('hostname', ['-s'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) r = spawnSync('hostname', [], { encoding: 'utf8' });
  return (r.stdout || '').trim().split('.')[0] || 'unknown';
}

const TRIPLET_RE = /^([^@]+)@([^:]+):(.+)$/;

/** `workspace@harness:machine` → its three parts, or null when the string is not a triplet. */
export function parseTriplet(triplet) {
  const m = typeof triplet === 'string' ? triplet.match(TRIPLET_RE) : null;
  if (!m) return null;
  return { workspaceId: m[1], harness: m[2], machine: m[3] };
}

export function composeTriplet(workspaceId, harness, machine) {
  return `${workspaceId}@${harness}:${machine}`;
}

/**
 * A filesystem-safe key for a participant that does NOT include the harness.
 * Used to partition cursor state: the same participant under a different harness reading
 * must land on the same cursor file, or a relabel strands its read position.
 */
export function identityKeyFromTriplet(triplet) {
  const p = parseTriplet(triplet);
  const raw = p ? `${p.workspaceId}--${p.machine}` : String(triplet);
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-participant';
}

export function mintParticipantId() {
  // uuid carries the uniqueness; the prefix makes the field self-describing in a ledger.
  return `pcp-${randomUUID()}`;
}

function safeFileName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

export function identityRecordPath(workspaceId) {
  return join(identityRoot(), `${safeFileName(workspaceId)}.json`);
}

export function readIdentityRecord(workspaceId) {
  const path = identityRecordPath(workspaceId);
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(readFileSync(path, 'utf8'));
    if (!rec || typeof rec !== 'object') return null;
    if (typeof rec.participant_id !== 'string' || typeof rec.triplet !== 'string') return null;
    return rec;
  } catch {
    // A corrupt record is treated as absent. The adoption read below then recovers the
    // identity from the channel ledger, which is the more authoritative source anyway.
    return null;
  }
}

export function writeIdentityRecord(record) {
  const path = identityRecordPath(record.workspace_id);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomBytes(2).toString('hex')}`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, path);
  return record;
}

/**
 * The compatibility read.
 *
 * Channels that predate this module carry join events with no `participant_id`, authored
 * under a triplet whose harness component was whatever the environment reported that day.
 * Those channels must keep working, so the identity a channel ALREADY ADMITTED outranks
 * anything this machine would mint.
 *
 * Matching rules, in order:
 *   1. `participant_id` equality — exact, once both sides have one.
 *   2. author string equality — exact.
 *   3. same workspace AND same machine, harness ignored — the legacy read.
 *
 * Rule 3 ignores the harness and nothing else. The machine component still has to match
 * character for character: a hostname that drifted by punctuation is a different identity
 * and the repair for that is an explicit rejoin, not a string transform.
 *
 * Rule 3 also refuses to guess. If two distinct legacy authors share this workspace and
 * machine, the ledger does not say which one is us, so nothing is adopted.
 */
export function findAdmittedIdentity(events, { workspaceId, machine, participantId, triplet }) {
  if (!Array.isArray(events)) return null;
  const joins = events.filter(e => e && e.type === 'join' && typeof e.author === 'string');
  if (joins.length === 0) return null;

  if (participantId) {
    const byId = joins.find(e => e.participant_id === participantId);
    if (byId) return { author: byId.author, participant_id: byId.participant_id, match: 'participant-id' };
  }
  if (triplet) {
    const byAuthor = joins.find(e => e.author === triplet);
    if (byAuthor) {
      return { author: byAuthor.author, participant_id: byAuthor.participant_id || null, match: 'author' };
    }
  }

  const legacy = [];
  for (const e of joins) {
    const p = parseTriplet(e.author);
    if (!p) continue;
    if (p.workspaceId !== workspaceId || p.machine !== machine) continue;
    if (!legacy.some(x => x.author === e.author)) {
      legacy.push({ author: e.author, participant_id: e.participant_id || null });
    }
  }
  if (legacy.length !== 1) return null; // absent, or ambiguous — do not guess
  return { ...legacy[0], match: 'legacy-harness-insensitive' };
}

/**
 * Resolve this machine's participant identity for a workspace.
 *
 * @param {string} workspaceId
 * @param {object} [opts]
 * @param {Array}  [opts.events] — a channel's events. When supplied, the identity that
 *        channel admitted wins over a fresh mint (the compatibility read above).
 * @returns {{participant_id: string, triplet: string, workspace_id: string, machine: string,
 *            harness: string, harness_at_mint: string, minted_at: string, source: string}}
 */
/** The refusal for a call with no `--workspace-id` and no legacy identity to fall back on. */
export function missingWorkspaceId(cwd = process.cwd()) {
  const e = new Error(`--workspace-id is required: pass a stable name for this workspace and reuse it every time (for example --workspace-id ${safeFileName(basename(cwd))}; with core-plugin installed, use the project's project_id)`);
  e.code = 'EWORKSPACEID';
  return e;
}

export function resolveIdentity(workspaceId, opts = {}) {
  const ws = workspaceId || 'unknown';
  const machine = deriveMachine();
  const harness = detectHarness();           // advisory, read fresh, never stored in the id
  let record = readIdentityRecord(ws);

  const admitted = opts.events
    ? findAdmittedIdentity(opts.events, {
        workspaceId: ws, machine,
        participantId: record?.participant_id, triplet: record?.triplet,
      })
    : null;

  // No workspace id: an identity already minted or admitted under the old 'unknown' default is
  // kept; anyone else must name the workspace, so two unrelated workspaces never share one.
  if (safeFileName(ws) === 'unknown' && !record && !admitted) throw missingWorkspaceId();

  if (!record) {
    // First contact. If a channel already admitted us, mint AGAINST that ledger rather than
    // against the current environment — otherwise upgrading an install with a moved harness
    // env renames the participant on its very first tick, which is the defect this fixes.
    record = writeIdentityRecord({
      participant_id: admitted?.participant_id || mintParticipantId(),
      triplet: admitted?.author || composeTriplet(ws, harness, machine),
      workspace_id: ws,
      machine,
      harness_at_mint: admitted ? (parseTriplet(admitted.author)?.harness ?? harness) : harness,
      minted_at: new Date().toISOString(),
      ...(admitted ? { adopted_from: admitted.match } : {}),
    });
    return { ...record, harness, source: admitted ? `adopted:${admitted.match}` : 'minted' };
  }

  // A record exists. If this particular channel admitted us under a different string, use
  // the channel's string HERE and do not rewrite the global record — one legacy channel
  // must not relabel the participant everywhere else.
  if (admitted && admitted.author !== record.triplet) {
    return { ...record, triplet: admitted.author, harness, source: `channel-scoped:${admitted.match}` };
  }

  return { ...record, harness, source: 'persisted' };
}

/**
 * Read-only lookup for another plugin that needs this workspace's persisted participant
 * (CORE's collab sync passes its opaque project id as the workspace id). Never mints.
 * Exit 0 with {workspace_id, triplet, participant_id}; 3 when no record exists; 4 when the
 * record is unreadable, malformed or has an empty field; 5 when the record stores a different
 * workspace id than the one asked for.
 */
export function showIdentity(workspaceId) {
  const path = identityRecordPath(workspaceId);
  if (!existsSync(path)) return { code: 3, error: `no identity record for workspace ${workspaceId}` };
  let rec;
  try { rec = JSON.parse(readFileSync(path, 'utf8')); } catch { return { code: 4, error: `identity record unreadable: ${path}` }; }
  if (!rec || typeof rec.participant_id !== 'string' || !rec.participant_id.trim() || typeof rec.triplet !== 'string' || !rec.triplet.trim()) return { code: 4, error: `identity record malformed: ${path}` };
  // A restored or misfiled record must not answer for another workspace: the id it stores is the binding.
  if (rec.workspace_id !== workspaceId) return { code: 5, error: `identity record at ${path} belongs to workspace ${JSON.stringify(rec.workspace_id)}, not ${workspaceId}` };
  return { code: 0, out: { workspace_id: rec.workspace_id, triplet: rec.triplet, participant_id: rec.participant_id } };
}

const _real = (p) => { try { return realpathSync(p); } catch { return p; } };
if (process.argv[1] && _real(process.argv[1]) === _real(fileURLToPath(import.meta.url))) {
  const i = process.argv.indexOf('--show');
  const ws = i > -1 ? process.argv[i + 1] : null;
  if (!ws) { process.stderr.write('usage: collab-identity.mjs --show <workspace-id>\n'); process.exitCode = 2; }
  else {
    const r = showIdentity(ws);
    if (r.code === 0) process.stdout.write(JSON.stringify(r.out) + '\n'); else process.stderr.write(r.error + '\n');
    process.exitCode = r.code;
  }
}
