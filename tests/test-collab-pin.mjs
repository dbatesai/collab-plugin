import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePin, isPinRef } from '../skills/collab/scripts/collab-event-helpers.mjs';
import { buildKickoffPayload } from '../skills/collab/scripts/collab-kickoff.mjs';
import { detectAction, extractSlug } from '../skills/collab/scripts/collab-route.mjs';
import { validateEvents } from '../skills/collab/scripts/collab-validate.mjs';

// --- generatePin ---

test('generatePin returns a 6-digit string', () => {
  for (let i = 0; i < 50; i++) {
    const pin = generatePin();
    assert.match(pin, /^\d{6}$/, `got: ${pin}`);
  }
});

test('generatePin is reasonably distributed (no constant return)', () => {
  const pins = new Set();
  for (let i = 0; i < 20; i++) pins.add(generatePin());
  assert.ok(pins.size > 1, 'expected at least 2 unique pins in 20 draws');
});

// --- isPinRef ---

test('isPinRef true for exactly 6 digits', () => {
  assert.equal(isPinRef('654321'), true);
  assert.equal(isPinRef('000000'), true);
  assert.equal(isPinRef('999999'), true);
});

test('isPinRef false for non-6-digit', () => {
  assert.equal(isPinRef('12345'), false);     // 5 digits
  assert.equal(isPinRef('1234567'), false);   // 7 digits
  assert.equal(isPinRef('abcdef'), false);    // letters
  assert.equal(isPinRef('memory-arch'), false);
  assert.equal(isPinRef(''), false);
  assert.equal(isPinRef(null), false);
  assert.equal(isPinRef(undefined), false);
});

// --- buildKickoffPayload with pin ---

test('buildKickoffPayload includes pin when provided', () => {
  const p = buildKickoffPayload('t', { intention: 'i', goal: 'g', measure: 'm' }, [], 24, undefined, '654321');
  assert.equal(p.pin, '654321');
});

test('buildKickoffPayload omits pin when not provided', () => {
  const p = buildKickoffPayload('t', { intention: 'i', goal: 'g', measure: 'm' }, [], 24);
  assert.equal(p.pin, undefined);
  assert.ok(!('pin' in p), 'pin field should not be present');
});

test('buildKickoffPayload ignores malformed pin (defensive)', () => {
  const p = buildKickoffPayload('t', { intention: 'i', goal: 'g', measure: 'm' }, [], 24, undefined, 'notapin');
  assert.equal(p.pin, undefined);
});

// --- route: bare PIN extraction + resolution ---

const SLUG = '654321-collab';  // unused — slug is unrelated to pin in real world; using a plain semantic slug below
const FULL_SLUG = 'rework-v02-transport-modes-spec';
const PIN = '654321';

function stateWithPin(pin, slug, opts = {}) {
  const state = {
    existsActive: new Set(opts.closed ? [] : [slug]),
    existsClosed: new Set(opts.closed ? [slug] : []),
    joined: new Set(opts.joined ? [slug] : []),
    pinIndex: new Map([[pin, slug]]),
  };
  return state;
}

test('extractSlug: bare 6-digit PIN', () => {
  assert.equal(extractSlug('/collab 654321'), '654321');
  assert.equal(extractSlug('look at 654321'), '654321');
  // The slug-keyword path matches first, so 'slug 654321' goes through the slug regex
  assert.equal(extractSlug('look at slug 654321'), '654321');
});

test('extractSlug: 5 or 7 digits do NOT match the bare-PIN pattern', () => {
  // 5-digit alone shouldn't match bare-PIN
  assert.equal(extractSlug('/collab 12345'), null);
  // 7-digit shouldn't match (would consume \b boundary)
  assert.equal(extractSlug('/collab 1234567'), null);
});

test('detectAction: bare PIN resolves to slug → join (not yet joined)', () => {
  const state = stateWithPin(PIN, FULL_SLUG);
  const r = detectAction('/collab 654321', state);
  assert.equal(r.route, 'join');
  assert.equal(r.slug, FULL_SLUG, 'slug should be the resolved full slug, not the PIN');
});

test('detectAction: bare PIN with informal context → join', () => {
  // David's exact use case: "/collab localhost 654321"
  const state = stateWithPin(PIN, FULL_SLUG);
  const r = detectAction('/collab localhost 654321', state);
  assert.equal(r.route, 'join');
  assert.equal(r.slug, FULL_SLUG);
});

test('detectAction: bare PIN, already joined → tick', () => {
  const state = stateWithPin(PIN, FULL_SLUG, { joined: true });
  const r = detectAction('/collab 654321', state);
  assert.equal(r.route, 'tick');
  assert.equal(r.slug, FULL_SLUG);
});

test('detectAction: status + PIN → status', () => {
  const state = stateWithPin(PIN, FULL_SLUG, { joined: true });
  const r = detectAction('status 654321', state);
  assert.equal(r.route, 'status');
  assert.equal(r.slug, FULL_SLUG);
});

test('detectAction: abort + PIN → abort', () => {
  const state = stateWithPin(PIN, FULL_SLUG, { joined: true });
  const r = detectAction('abort 654321', state);
  assert.equal(r.route, 'abort');
  assert.equal(r.slug, FULL_SLUG);
});

test('detectAction: PIN not in index → fuzzy', () => {
  const state = stateWithPin('999999', FULL_SLUG);
  const r = detectAction('/collab 111111', state);
  assert.equal(r.route, 'fuzzy');
});

test('detectAction: full slug reference still works (backward compat)', () => {
  const state = stateWithPin(PIN, FULL_SLUG);
  const r = detectAction(`look at slug ${FULL_SLUG}`, state);
  assert.equal(r.route, 'join');
  assert.equal(r.slug, FULL_SLUG);
});

// --- validator ---

const KO_BASE = {
  event_id: 'evt-001', ts: '2026-05-25T10:00:00Z',
  author: 'a@cc:m1', slug: 's', type: 'kickoff', references: [],
  payload: { message: 't', igm: { intention: 'i', goal: 'g', measure: 'm' }, capabilities_wanted: [], wall_clock_hours: 24 },
};

test('validateEvents: kickoff with valid 6-digit pin passes', () => {
  const ko = { ...KO_BASE, payload: { ...KO_BASE.payload, pin: '654321' } };
  assert.equal(validateEvents([ko]).valid, true);
});

test('validateEvents: kickoff with malformed pin fails', () => {
  const ko = { ...KO_BASE, payload: { ...KO_BASE.payload, pin: '12345' } };
  const r = validateEvents([ko]);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('pin')));
});

test('validateEvents: kickoff without pin still passes (backward compat)', () => {
  assert.equal(validateEvents([KO_BASE]).valid, true);
});
