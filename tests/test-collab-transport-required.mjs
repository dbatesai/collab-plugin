/**
 * test-collab-transport-required.mjs — a kickoff must not pick a transport for you.
 *
 * D8. Starting a collab with no transport token used to resolve to `github:files`
 * silently. That default can put a collaboration on a git repo the other agent
 * cannot reach, or — read the other way — strand a cross-machine collab on a
 * filesystem only one participant can see. Either way the ledger recorded the
 * value without recording that nobody chose it, so the mistake was invisible
 * afterwards.
 *
 * A kickoff with no transport now refuses and asks. Every other route is
 * untouched: join, tick, status, and abort resolve the transport from disk by
 * finding the slug, which is why an existing channel never has to be told.
 *
 * The read-time fallbacks that treat a v0.1.x kickoff payload with no transport
 * field as `github:files` are a different mechanism and deliberately unchanged —
 * those channels exist and must keep working.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAction } from '../skills/collab/scripts/collab-route.mjs';

const emptyView = () => ({ existsActive: new Set(), existsClosed: new Set(), joined: new Set() });
const stateWith = (slug, transport, opts = {}) => {
  const view = emptyView();
  if (slug) (opts.joined ? view.joined : view.existsActive).add(slug);
  if (opts.joined) view.existsActive.add(slug);
  return { byTransport: { [transport]: view }, pinIndex: new Map() };
};

test('a kickoff with no transport refuses instead of picking one', () => {
  const state = { byTransport: { 'github:files': emptyView() }, pinIndex: new Map() };
  const r = detectAction('discuss the architecture', state, null);

  assert.notEqual(r.route, 'kickoff',
    'a kickoff with no transport must not proceed — it used to silently pick github:files');
  assert.equal(r.route, 'transport-required');
  assert.equal(r.transport, null, 'refusing means naming no transport at all');
  assert.match(r.reason, /transport/i, `the refusal must say what is missing: ${r.reason}`);
});

test('a kickoff with an explicit transport proceeds', () => {
  for (const transport of ['localhost', 'github:files', 'github:some-repo']) {
    const state = { byTransport: { [transport]: emptyView() }, pinIndex: new Map() };
    const r = detectAction('discuss the architecture', state, transport);
    assert.equal(r.route, 'kickoff', `explicit ${transport} must still kick off`);
    assert.equal(r.transport, transport);
    assert.equal(r.transportBasis, 'explicit',
      'the ledger has to be able to tell a chosen transport from a defaulted one');
  }
});

// The refusal is scoped to kickoff on purpose. Every other route finds the slug
// on disk, so demanding a transport there would be asking for something the
// system already knows — and would break every existing channel.
test('rejoining an existing collab still needs no transport token', () => {
  const state = stateWith('memory-arch', 'localhost');
  const r = detectAction('look at slug memory-arch', state, null);
  assert.equal(r.route, 'join');
  assert.equal(r.transport, 'localhost', 'resolved from disk, not from a default');
});

test('ticking an existing collab still needs no transport token', () => {
  const state = stateWith('memory-arch', 'localhost', { joined: true });
  const r = detectAction('look at slug memory-arch', state, null);
  assert.equal(r.route, 'tick');
  assert.equal(r.transport, 'localhost');
});

test('status and abort on an existing collab still need no transport token', () => {
  for (const [message, expected] of [['status of memory-arch', 'status'], ['abort memory-arch', 'abort']]) {
    const state = stateWith('memory-arch', 'github:files');
    const r = detectAction(message, state, null);
    assert.equal(r.route, expected, `${expected} must resolve from disk`);
    assert.equal(r.transport, 'github:files');
  }
});
