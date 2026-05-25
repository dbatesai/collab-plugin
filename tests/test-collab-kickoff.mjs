import { test } from 'node:test';
import assert from 'node:assert/strict';

let deriveSlug, nextEventId, authorSlugFromTriplet;
try {
  const m = await import('../skills/collab/scripts/collab-event-helpers.mjs');
  deriveSlug = m.deriveSlug;
  nextEventId = m.nextEventId;
  authorSlugFromTriplet = m.authorSlugFromTriplet;
} catch {
  deriveSlug = nextEventId = authorSlugFromTriplet = () => { throw new Error('not implemented'); };
}

test('deriveSlug: basic message', () => {
  assert.equal(deriveSlug('memory architecture review'), 'memory-architecture-review');
});

test('deriveSlug: strips punctuation', () => {
  assert.equal(deriveSlug('review: v2.3 (final)'), 'review-v23-final');
});

test('deriveSlug: max 50 chars', () => {
  assert.ok(deriveSlug('a'.repeat(60)).length <= 50);
});

test('deriveSlug: collapses whitespace', () => {
  assert.equal(deriveSlug('hello   world'), 'hello-world');
});

test('deriveSlug: no trailing dash', () => {
  const s = deriveSlug('hello!');
  assert.ok(!s.endsWith('-'), `got: ${s}`);
});

test('nextEventId: first event returns evt-001', () => {
  assert.equal(nextEventId([]), 'evt-001');
});

test('nextEventId: increments from last', () => {
  assert.equal(nextEventId([{ event_id: 'evt-001' }, { event_id: 'evt-002' }]), 'evt-003');
});

test('nextEventId: widens at 999', () => {
  assert.equal(nextEventId([{ event_id: 'evt-999' }]), 'evt-1000');
});

test('authorSlugFromTriplet: extracts workspace id', () => {
  assert.equal(authorSlugFromTriplet('core-framework@claude-code:home'), 'core-framework');
});
