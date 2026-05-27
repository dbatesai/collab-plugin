import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { listCollabs } from '../skills/collab/scripts/collab-list.mjs';
import { LOCAL_COLLABS_ROOT } from '../skills/collab/scripts/transport.mjs';
import { appendEvent } from '../skills/collab/scripts/collab-event-helpers.mjs';

test('listCollabs returns rows from localhost transport', () => {
  const slug = 'test-list-' + Date.now();
  const dirName = `2026-05-25-${slug}`;
  const dir = join(LOCAL_COLLABS_ROOT, dirName);
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a@cc:m5', slug, type: 'kickoff', references: [], payload: { transport: 'localhost' } });
  appendEvent(dir, { event_id: 'evt-002', ts: '2026-05-25T09:23:00Z', author: 'a@cc:m5', slug, type: 'join', references: ['evt-001'], payload: {} });
  try {
    const rows = listCollabs();
    const hit = rows.find(r => r.slug === slug);
    assert.ok(hit, 'expected to find the test collab');
    assert.equal(hit.transport, 'localhost');
    assert.equal(hit.state, 'active');
    assert.equal(hit.participants, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listCollabs --closed filter excludes active collabs', () => {
  const slug = 'test-list-active-' + Date.now();
  const dirName = `2026-05-25-${slug}`;
  const dir = join(LOCAL_COLLABS_ROOT, dirName);
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a@cc:m5', slug, type: 'kickoff', references: [], payload: { transport: 'localhost' } });
  try {
    const rows = listCollabs({ filter: 'closed' });
    assert.ok(!rows.find(r => r.slug === slug), 'active collab should be excluded by --closed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listCollabs with only=localhost restricts to localhost transport', () => {
  const slug = 'test-list-only-' + Date.now();
  const dirName = `2026-05-25-${slug}`;
  const dir = join(LOCAL_COLLABS_ROOT, dirName);
  mkdirSync(join(dir, 'events'), { recursive: true });
  appendEvent(dir, { event_id: 'evt-001', ts: '2026-05-25T09:22:00Z', author: 'a@cc:m5', slug, type: 'kickoff', references: [], payload: { transport: 'localhost' } });
  try {
    const rows = listCollabs({ only: 'localhost' });
    assert.ok(rows.every(r => r.transport === 'localhost'), 'only localhost rows should be returned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
