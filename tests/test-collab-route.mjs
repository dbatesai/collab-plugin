import { test } from 'node:test';
import assert from 'node:assert/strict';

let detectAction, extractTransport;
try {
  ({ detectAction, extractTransport } = await import('../skills/collab/scripts/collab-route.mjs'));
} catch {
  detectAction = () => { throw new Error('not implemented'); };
  extractTransport = () => { throw new Error('not implemented'); };
}

// Helper to build new byTransport-shaped state from old flat fields. By default
// the legacy single-transport tests target 'github:files' (the default route).
function stateWith({ existsActive = new Set(), existsClosed = new Set(), joined = new Set(), pinIndex = new Map(), transport = 'github:files' } = {}) {
  return {
    byTransport: { [transport]: { existsActive, existsClosed, joined } },
    pinIndex,
  };
}

const STATE_EMPTY = stateWith();
const STATE_OPEN = stateWith({ existsActive: new Set(['memory-arch']) });
const STATE_JOINED = stateWith({ existsActive: new Set(['memory-arch']), joined: new Set(['memory-arch']) });

test('no slug, describes work → kickoff', () => {
  const r = detectAction('do a memory architecture review', STATE_EMPTY, null);
  assert.equal(r.route, 'kickoff');
});

test('look at slug X, not joined → join', () => {
  const r = detectAction('look at slug memory-arch', STATE_OPEN, null);
  assert.equal(r.route, 'join');
  assert.equal(r.slug, 'memory-arch');
});

test('look at slug X, already joined → tick', () => {
  const r = detectAction('look at slug memory-arch', STATE_JOINED, null);
  assert.equal(r.route, 'tick');
  assert.equal(r.slug, 'memory-arch');
});

test('status of X → status', () => {
  const r = detectAction('status of memory-arch', STATE_JOINED, null);
  assert.equal(r.route, 'status');
  assert.equal(r.slug, 'memory-arch');
});

test('what is happening with X → status', () => {
  const r = detectAction("what's happening with memory-arch", STATE_JOINED, null);
  assert.equal(r.route, 'status');
});

test('abort X → abort', () => {
  const r = detectAction('abort memory-arch', STATE_JOINED, null);
  assert.equal(r.route, 'abort');
  assert.equal(r.slug, 'memory-arch');
});

test('cancel slug X → abort', () => {
  const r = detectAction('cancel slug memory-arch', STATE_JOINED, null);
  assert.equal(r.route, 'abort');
});

test('slug ambiguous (not in state) and message describes work → kickoff', () => {
  const r = detectAction('do a brand new task', STATE_OPEN, null);
  assert.equal(r.route, 'kickoff');
});

test('slug X exists but closed, ambiguous message → fuzzy', () => {
  const r = detectAction('look at memory-arch', stateWith({ existsClosed: new Set(['memory-arch']) }), null);
  assert.ok(['fuzzy', 'status'].includes(r.route));
});

test('explicit slug not found anywhere → fuzzy', () => {
  const r = detectAction('look at slug nonexistent-thing', STATE_EMPTY, null);
  assert.equal(r.route, 'fuzzy');
  assert.equal(r.extractedSlug, 'nonexistent-thing');
});

// --- v0.2 transport-aware routing (T6) ---

test('extractTransport pulls leading localhost token', () => {
  const r = extractTransport('localhost discuss memory');
  assert.deepEqual(r, { transport: 'localhost', rest: 'discuss memory' });
});

test('extractTransport pulls leading github:<repo> token', () => {
  const r = extractTransport('github:files look at slug memory-arch');
  assert.deepEqual(r, { transport: 'github:files', rest: 'look at slug memory-arch' });
});

test('extractTransport handles verb prefix before transport', () => {
  const r = extractTransport('look at localhost slug memory-arch');
  assert.deepEqual(r, { transport: 'localhost', rest: 'slug memory-arch' });
});

test('extractTransport defaults to null when no token present', () => {
  const r = extractTransport('discuss the architecture');
  assert.deepEqual(r, { transport: null, rest: 'discuss the architecture' });
});

test('extractTransport consumes only one transport token', () => {
  const r = extractTransport('localhost discuss localhost-and-cloud');
  assert.deepEqual(r, { transport: 'localhost', rest: 'discuss localhost-and-cloud' });
});

test('extractTransport handles bare "localhost" with no trailing space', () => {
  const r = extractTransport('localhost');
  assert.deepEqual(r, { transport: null, rest: 'localhost' });
});

test('extractTransport handles "abort localhost slug X" — verb prefix swallows abort, transport extracts', () => {
  const r = extractTransport('abort localhost slug memory-arch');
  assert.deepEqual(r, { transport: 'localhost', rest: 'slug memory-arch' });
});

test('detectAction with no explicit transport defaults to github:files', () => {
  const state = { byTransport: { 'github:files': { existsActive: new Set(), existsClosed: new Set(), joined: new Set() } }, pinIndex: new Map() };
  const r = detectAction('discuss the architecture', state, null);
  assert.equal(r.route, 'kickoff');
  assert.equal(r.transport, 'github:files');
});

test('detectAction routes join when slug exists in the named transport', () => {
  const state = {
    byTransport: {
      'localhost': { existsActive: new Set(['memory-arch']), existsClosed: new Set(), joined: new Set() },
      'github:files': { existsActive: new Set(), existsClosed: new Set(), joined: new Set() },
    },
    pinIndex: new Map(),
  };
  const r = detectAction('look at slug memory-arch', state, 'localhost');
  assert.equal(r.route, 'join');
  assert.equal(r.transport, 'localhost');
  assert.equal(r.slug, 'memory-arch');
});

test('detectAction routes tick when slug exists in named transport and agent has joined', () => {
  const state = {
    byTransport: {
      'localhost': { existsActive: new Set(['memory-arch']), existsClosed: new Set(), joined: new Set(['memory-arch']) },
    },
    pinIndex: new Map(),
  };
  const r = detectAction('look at slug memory-arch', state, 'localhost');
  assert.equal(r.route, 'tick');
  assert.equal(r.transport, 'localhost');
});
