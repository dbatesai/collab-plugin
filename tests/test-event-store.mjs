import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateEventId, readEvents, appendEvent, renderEventsJsonl,
} from '../skills/collab/scripts/collab-event-helpers.mjs';

function mkCollabDir() {
  const dir = mkdtempSync(join(tmpdir(), 'collab-event-store-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  return dir;
}

test('generateEventId produces YYYYMMDDHHmm-<author>-<4hex> format', () => {
  const id = generateEventId('2026-05-25T09:22:00Z', 'core-gemini');
  assert.match(id, /^evt-202605250922-core-gemini-[0-9a-f]{4}$/);
});

test('generateEventId is unique across rapid calls', () => {
  const ts = '2026-05-25T09:22:00Z';
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(generateEventId(ts, 'core-hk'));
  assert.equal(ids.size, 100);
});

test('appendEvent writes a single JSON file in events/ via atomic rename', () => {
  const dir = mkCollabDir();
  const evt = { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'hk@cc:m5', slug: 's', type: 'turn', references: [], payload: { content: 'hi' } };
  appendEvent(dir, evt);
  const files = readdirSync(join(dir, 'events')).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1);
  const content = JSON.parse(readFileSync(join(dir, 'events', files[0]), 'utf8'));
  assert.equal(content.event_id, 'evt-202605250922-hk-aaaa');
  rmSync(dir, { recursive: true, force: true });
});

test('readEvents reads from events/ dir, sorted by ts then event_id', () => {
  const dir = mkCollabDir();
  const events = [
    { event_id: 'evt-202605250930-hk-bbbb', ts: '2026-05-25T09:30:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} },
    { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} },
  ];
  for (const e of events) appendEvent(dir, e);
  const read = readEvents(dir);
  assert.equal(read.length, 2);
  assert.equal(read[0].event_id, 'evt-202605250922-hk-aaaa');
  assert.equal(read[1].event_id, 'evt-202605250930-hk-bbbb');
  rmSync(dir, { recursive: true, force: true });
});

test('readEvents skips and warns on malformed JSON files', () => {
  const dir = mkCollabDir();
  writeFileSync(join(dir, 'events', 'evt-malformed.json'), '{not valid json');
  appendEvent(dir, { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} });
  const events = readEvents(dir);
  assert.equal(events.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('readEvents deduplicates events with the same event_id (first wins)', () => {
  const dir = mkCollabDir();
  const dup = { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: { v: 1 } };
  appendEvent(dir, dup);
  writeFileSync(join(dir, 'events', 'evt-dup-2.json'), JSON.stringify({ ...dup, payload: { v: 2 } }));
  const events = readEvents(dir);
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.v, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('readEvents falls back to events.jsonl when events/ does not exist (v0.1.x compat)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-jsonl-compat-'));
  const evt1 = { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'kickoff', references: [], payload: {} };
  const evt2 = { event_id: 'evt-002', ts: '2026-05-25T09:23:00Z', author: 'a', slug: 's', type: 'join', references: ['evt-001'], payload: {} };
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(evt1) + '\n' + JSON.stringify(evt2) + '\n');
  const events = readEvents(dir);
  assert.equal(events.length, 2);
  assert.equal(events[0].event_id, 'evt-001');
  assert.equal(events[1].event_id, 'evt-002');
  rmSync(dir, { recursive: true, force: true });
});

test('renderEventsJsonl writes events.jsonl from events/ dir in sort order', () => {
  const dir = mkCollabDir();
  appendEvent(dir, { event_id: 'evt-202605250930-hk-bbbb', ts: '2026-05-25T09:30:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} });
  appendEvent(dir, { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} });
  renderEventsJsonl(dir);
  const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).event_id, 'evt-202605250922-hk-aaaa');
  assert.equal(JSON.parse(lines[1]).event_id, 'evt-202605250930-hk-bbbb');
  rmSync(dir, { recursive: true, force: true });
});

test('appendEvent uses temp-then-rename (no partial files visible)', () => {
  const dir = mkCollabDir();
  for (let i = 0; i < 10; i++) {
    appendEvent(dir, { event_id: `evt-202605250922-hk-${String(i).padStart(4, '0')}`, ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} });
  }
  const stragglers = readdirSync(join(dir, 'events')).filter(f => f.startsWith('.tmp-'));
  assert.equal(stragglers.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('appendEvent refuses to write to v0.1.x hybrid dir (events.jsonl present, events/ absent)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-v01x-hybrid-'));
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'kickoff', references: [], payload: {} }) + '\n');
  const evt = { event_id: 'evt-202605250922-hk-aaaa', ts: '2026-05-25T09:22:00Z', author: 'a', slug: 's', type: 'turn', references: [], payload: {} };
  assert.throws(() => appendEvent(dir, evt), /v0\.1\.x collab/);
  rmSync(dir, { recursive: true, force: true });
});
