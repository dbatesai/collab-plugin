/**
 * test-collab-validate-system-events.mjs — the validator must recognize the
 * events the system itself writes.
 *
 * `reconciled`, `quarantined`, and `timeout-action` are emitted by the repair
 * and safety-net paths, not by any participant. If the validator does not know
 * them, then healing a foreign surface, quarantining a peer's malformed event,
 * or firing a declared timeout each leave a channel that reports its own repair
 * work as a schema error — and the operator's only signal that repair happened
 * gets buried under errors that are not errors.
 *
 * Same family as D10: two vocabularies, one field, no single home.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvents } from '../skills/collab/scripts/collab-validate.mjs';

const TS = '2026-07-30T12:00:00.000Z';

function evt(type, payload = {}, extra = {}) {
  return {
    event_id: `evt-${type}-1`,
    ts: TS,
    author: 'core-framework@claude-code:host',
    slug: 'validate-system-events',
    type,
    payload,
    ...extra,
  };
}

// A minimally valid participant-authored spine, so the only thing under test is
// whether the system-authored types are recognized.
const SPINE = [
  evt('kickoff', {
    message: 'test', igm: { measure: 'x' }, capabilities_wanted: [], wall_clock_hours: 1,
  }),
  evt('join', { capability_match: 'x', commitment: { next_update_by: TS } }),
];

const SYSTEM_EVENTS = [
  ['reconciled', { imported: ['evt-foreign-1'] }, { references: ['evt-foreign-1'] }],
  ['quarantined', { reason: 'missing provenance', source: 'events.jsonl' }],
  ['timeout-action', { participant: 'peer@codex:host', action: 'degrade-and-continue' }],
];

for (const [type, payload, extra] of SYSTEM_EVENTS) {
  test(`the validator recognizes the system-emitted "${type}" event`, () => {
    const { errors } = validateEvents([...SPINE, evt(type, payload, extra)]);
    const unknown = errors.filter((e) => e.includes('unknown type'));
    assert.deepEqual(unknown, [],
      `the system writes "${type}" itself, so validating a channel that contains one must not ` +
      `report it as a schema error. Got: ${JSON.stringify(unknown)}`);
  });
}

test('a genuinely unknown type is still rejected', () => {
  const { errors } = validateEvents([...SPINE, evt('not-a-real-type')]);
  assert.ok(errors.some((e) => e.includes('unknown type: not-a-real-type')),
    'widening the vocabulary must not turn the check off — an invented type must still fail');
});
