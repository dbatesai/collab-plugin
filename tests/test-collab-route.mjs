import { test } from 'node:test';
import assert from 'node:assert/strict';

let detectAction;
try { ({ detectAction } = await import('../skills/collab/scripts/collab-route.mjs')); }
catch { detectAction = () => { throw new Error('not implemented'); }; }

const STATE_EMPTY = { existsActive: new Set(), existsClosed: new Set(), joined: new Set() };
const STATE_OPEN = { existsActive: new Set(['memory-arch']), existsClosed: new Set(), joined: new Set() };
const STATE_JOINED = { existsActive: new Set(['memory-arch']), existsClosed: new Set(), joined: new Set(['memory-arch']) };

test('no slug, describes work → kickoff', () => {
  const r = detectAction('do a memory architecture review', STATE_EMPTY);
  assert.equal(r.route, 'kickoff');
});

test('look at slug X, not joined → join', () => {
  const r = detectAction('look at slug memory-arch', STATE_OPEN);
  assert.equal(r.route, 'join');
  assert.equal(r.slug, 'memory-arch');
});

test('look at slug X, already joined → tick', () => {
  const r = detectAction('look at slug memory-arch', STATE_JOINED);
  assert.equal(r.route, 'tick');
  assert.equal(r.slug, 'memory-arch');
});

test('status of X → status', () => {
  const r = detectAction('status of memory-arch', STATE_JOINED);
  assert.equal(r.route, 'status');
  assert.equal(r.slug, 'memory-arch');
});

test('what is happening with X → status', () => {
  const r = detectAction("what's happening with memory-arch", STATE_JOINED);
  assert.equal(r.route, 'status');
});

test('abort X → abort', () => {
  const r = detectAction('abort memory-arch', STATE_JOINED);
  assert.equal(r.route, 'abort');
  assert.equal(r.slug, 'memory-arch');
});

test('cancel slug X → abort', () => {
  const r = detectAction('cancel slug memory-arch', STATE_JOINED);
  assert.equal(r.route, 'abort');
});

test('slug ambiguous (not in state) and message describes work → kickoff', () => {
  const r = detectAction('do a brand new task', STATE_OPEN);
  assert.equal(r.route, 'kickoff');
});

test('slug X exists but closed, ambiguous message → fuzzy', () => {
  const r = detectAction('look at memory-arch', { existsActive: new Set(), existsClosed: new Set(['memory-arch']), joined: new Set() });
  assert.ok(['fuzzy', 'status'].includes(r.route));
});

test('explicit slug not found anywhere → fuzzy', () => {
  const r = detectAction('look at slug nonexistent-thing', STATE_EMPTY);
  assert.equal(r.route, 'fuzzy');
  assert.equal(r.extractedSlug, 'nonexistent-thing');
});
