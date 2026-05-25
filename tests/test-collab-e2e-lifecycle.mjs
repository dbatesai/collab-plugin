import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvents } from '../skills/collab/scripts/collab-validate.mjs';

// Build a full clean lifecycle: kickoff + 3 joins + 3 turns + propose-close + 2 ratifies + close
function buildCleanLifecycle() {
  const T0 = '2026-05-25T10:00:00Z';
  return [
    { event_id:'evt-001', ts:T0, author:'orig@claude-code:m1', slug:'test', type:'kickoff', references:[],
      payload:{ message:'test', igm:{intention:'i',goal:'g',measure:'m'}, capabilities_wanted:['x'], wall_clock_hours:24, transport:'github:files' } },
    { event_id:'evt-002', ts:T0, author:'orig@claude-code:m1', slug:'test', type:'join', references:['evt-001'],
      payload:{ capability_match:[], commitment:'originator self-join' } },
    { event_id:'evt-003', ts:'2026-05-25T10:05:00Z', author:'peer1@claude-code:m2', slug:'test', type:'join', references:['evt-001'],
      payload:{ capability_match:['x'], commitment:'will contribute' } },
    { event_id:'evt-004', ts:'2026-05-25T10:10:00Z', author:'peer2@gemini:m1', slug:'test', type:'join', references:['evt-001'],
      payload:{ capability_match:['x'], commitment:'gemini side' } },
    { event_id:'evt-005', ts:'2026-05-25T10:15:00Z', author:'peer1@claude-code:m2', slug:'test', type:'turn', references:['evt-001'],
      payload:{ intent:'propose', body:'I propose X', signals:[] } },
    { event_id:'evt-006', ts:'2026-05-25T10:20:00Z', author:'peer2@gemini:m1', slug:'test', type:'turn', references:['evt-005'],
      payload:{ intent:'synthesize', body:'Integrating: X plus context Y', signals:[] } },
    { event_id:'evt-007', ts:'2026-05-25T10:25:00Z', author:'orig@claude-code:m1', slug:'test', type:'turn', references:['evt-005','evt-006'],
      payload:{ intent:'critique', body:'But consider edge case Z', signals:['confidence-medium'] } },
    { event_id:'evt-008', ts:'2026-05-25T10:30:00Z', author:'orig@claude-code:m1', slug:'test', type:'propose-close', references:['evt-007'],
      payload:{ synthesis:'Converged on X with caveat Z', igm_met:{ intention:{met:true,rationale:'r'}, goal:{met:true,rationale:'r'}, measure:{met:true,rationale:'r'} } } },
    { event_id:'evt-009', ts:'2026-05-25T10:35:00Z', author:'peer1@claude-code:m2', slug:'test', type:'ratify', references:['evt-008'],
      payload:{ agreement_notes:'agreed' } },
    { event_id:'evt-010', ts:'2026-05-25T10:40:00Z', author:'peer2@gemini:m1', slug:'test', type:'ratify', references:['evt-008'],
      payload:{ agreement_notes:'agreed' } },
    { event_id:'evt-011', ts:'2026-05-25T10:45:00Z', author:'orig@claude-code:m1', slug:'test', type:'close', references:['evt-008'],
      payload:{ final_synthesis:'closed converged', outcome:'converged' } },
  ];
}

test('e2e: full clean 3-agent lifecycle validates with no errors', () => {
  const events = buildCleanLifecycle();
  const r = validateEvents(events);
  assert.equal(r.valid, true, 'errors: ' + JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
});

test('e2e: clean lifecycle produces only timing-related warnings (no errors)', () => {
  const events = buildCleanLifecycle();
  const r = validateEvents(events);
  // Warnings should only be clock-skew related (events are 5 min apart, well under 1h)
  for (const w of r.warnings) {
    assert.ok(!w.includes('missing'), `Unexpected warning: ${w}`);
  }
});

// Regression tests for the 4 v0.1 bugs caught in Phase 3

test('regression v0.1 bug: turn missing signals field rejected', () => {
  // The bug WK + Gemini both hit
  const events = buildCleanLifecycle();
  delete events[4].payload.signals;
  const r = validateEvents(events);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('evt-005') && e.includes('signals')),
    'expected error mentioning evt-005 and signals; got: ' + JSON.stringify(r.errors));
});

test('regression v0.1 bug: turn with synthesis instead of body rejected', () => {
  // The exact shape Gemini emitted (evt-006 in real collab)
  const events = buildCleanLifecycle();
  events[5].payload = { intent: 'synthesize', synthesis: 'should be in body', signals: [] };
  const r = validateEvents(events);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('evt-006') && e.includes('body')),
    'expected error mentioning evt-006 and body; got: ' + JSON.stringify(r.errors));
});

test('regression v0.1 bug: turn missing intent rejected', () => {
  const events = buildCleanLifecycle();
  delete events[5].payload.intent;
  const r = validateEvents(events);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('intent')));
});

test('regression: propose-close missing igm_met rejected', () => {
  const events = buildCleanLifecycle();
  delete events[7].payload.igm_met;
  const r = validateEvents(events);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('igm_met')));
});

test('regression: close with bad outcome rejected', () => {
  const events = buildCleanLifecycle();
  events[10].payload.outcome = 'made-up-outcome';
  const r = validateEvents(events);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some(e => e.includes('made-up-outcome')));
});

test('regression: turn with extra fields tolerated (body+synthesis both present)', () => {
  // Verify that having BOTH body and synthesis on a turn doesn't fail
  // (only missing body fails; extra fields are tolerated)
  const events = buildCleanLifecycle();
  events[5].payload.synthesis = 'extra field, valid because body is also present';
  const r = validateEvents(events);
  assert.equal(r.valid, true, 'errors: ' + JSON.stringify(r.errors));
});
