/**
 * collab-anchor.mjs — the anchor order for localhost collabs.
 *
 * A localhost collab whose directory holds `order/` is anchored: every event file gets one
 * slot `order/<seq>.json` = {seq, event_id, sha256}, and the slot order (not writer clocks)
 * decides which events precede the first close. Slots are published like events — a fully
 * written temp file hard-linked into place — so a slot is never visible half-written, and
 * a taken number fails EEXIST. Every number below an existing slot was taken before it, so
 * a slot created after the close always lands above it.
 *
 * Assignment runs under `order/.lock` (mkdir). A held lock is refused by name; it is never
 * stolen. Inside the lock, unanchored event files are anchored first (sorted by ts, then
 * event_id), so an event whose slot write crashed is repaired by the next append.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ORDER_DIR = 'order';
export const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const LOCK_RETRIES = 50;
const LOCK_DELAY_MS = 20;

export const isAnchored = (collabDir) => existsSync(join(collabDir, ORDER_DIR));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Slots on disk, in seq order. Unparseable slot files are returned as refusals, never skipped. */
export function readSlots(collabDir) {
  const dir = join(collabDir, ORDER_DIR);
  const slots = [], bad = [];
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)\.json$/.exec(name);
    if (!m) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      // event_id becomes a path component in readers: filename-safe characters only, never a separator
      if (s.seq !== Number(m[1]) || typeof s.event_id !== 'string' || !EVENT_ID_RE.test(s.event_id) || !/^[0-9a-f]{64}$/.test(s.sha256)) throw new Error('shape');
      slots.push(s);
    } catch { bad.push(Number(m[1])); }
  }
  slots.sort((a, b) => a.seq - b.seq);
  return { slots, bad };
}

function eventFiles(collabDir) {
  const dir = join(collabDir, 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.json') && !n.startsWith('.')).map(n => {
    const bytes = readFileSync(join(dir, n));
    let ts = '';
    try { ts = JSON.parse(bytes.toString('utf8')).ts || ''; } catch { /* malformed: anchored by name order */ }
    return { event_id: n.slice(0, -5), sha256: sha256(bytes), ts };
  });
}

function publishSlot(collabDir, seq, event_id, digest) {
  const dir = join(collabDir, ORDER_DIR);
  const tmp = join(dir, `.tmp-${seq}-${process.pid}-${randomBytes(3).toString('hex')}`);
  writeFileSync(tmp, JSON.stringify({ seq, event_id, sha256: digest }) + '\n');
  try { linkSync(tmp, join(dir, `${seq}.json`)); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { try { unlinkSync(tmp); } catch { /* best effort */ } }
}

/**
 * Anchor every unanchored event file. Throws `order-lock-held` (code EORDERLOCK) when another
 * process holds the lock past the retry budget. Returns the slots this call created.
 */
export function anchorPending(collabDir) {
  const lock = join(collabDir, ORDER_DIR, '.lock');
  let held = false;
  for (let i = 0; i <= LOCK_RETRIES && !held; i++) {
    try { mkdirSync(lock); held = true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (i < LOCK_RETRIES) sleep(LOCK_DELAY_MS); }
  }
  if (!held) {
    const err = new Error(`refused:order-lock-held ${lock} — another writer holds it; it is never stolen. Retry, or remove it by hand once no writer is running.`);
    err.code = 'EORDERLOCK';
    throw err;
  }
  try {
    const { slots } = readSlots(collabDir);
    const anchored = new Set(slots.map(s => s.event_id));
    let next = slots.length ? slots[slots.length - 1].seq + 1 : 1;
    const created = [];
    const pending = eventFiles(collabDir).filter(f => !anchored.has(f.event_id))
      .sort((a, b) => (a.ts === b.ts ? (a.event_id < b.event_id ? -1 : 1) : (a.ts < b.ts ? -1 : 1)));
    for (const f of pending) {
      while (!publishSlot(collabDir, next, f.event_id, f.sha256)) next++;   // a taken number is skipped, never reused
      created.push({ seq: next, event_id: f.event_id });
      next++;
    }
    return created;
  } finally {
    rmdirSync(lock);
  }
}
