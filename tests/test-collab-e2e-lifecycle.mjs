import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateEvents } from '../skills/collab/scripts/collab-validate.mjs';
import { kickoff } from '../skills/collab/scripts/collab-kickoff.mjs';
import { tickDeterministic } from '../skills/collab/scripts/collab-tick.mjs';
import { appendEvent, readEvents, generateEventId, authorSlugFromTriplet, isClosed } from '../skills/collab/scripts/collab-event-helpers.mjs';
import { LOCAL_COLLABS_ROOT } from '../skills/collab/scripts/transport.mjs';

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

// v0.2 end-to-end localhost lifecycle: drives kickoff → tick (close) through real
// scripts on real disk under ~/.collab/local/, verifying the no-git path + one-event-per-file
// + events.jsonl render artifact all wire up correctly.
test('v0.2 e2e: localhost lifecycle — kickoff, propose-close, ratify, close', async () => {
  const uniq = 'e2e-localhost-' + Date.now();
  const message = `localhost ${uniq.replace(/-/g, ' ')}`;
  // Find created collab dir for cleanup; populated after kickoff
  let collabDir = null;
  try {
    const r = await kickoff(message, {
      workspaceId: 'test-e2e',
      transport: 'localhost',
      tickIntervalMinutes: 1,
      wallClockHours: 24,
    });
    collabDir = r.dir;
    assert.equal(r.transport, 'localhost');
    assert.ok(r.dir.startsWith(LOCAL_COLLABS_ROOT), `dir should be under ${LOCAL_COLLABS_ROOT}; got ${r.dir}`);
    assert.ok(existsSync(join(r.dir, 'events')), 'events/ dir should exist after kickoff');
    assert.ok(existsSync(join(r.dir, 'events.jsonl')), 'events.jsonl render artifact should exist');
    assert.ok(existsSync(join(r.dir, 'KICKOFF.md')), 'KICKOFF.md should exist');

    // No .tmp- stragglers
    const stragglers = readdirSync(join(r.dir, 'events')).filter(f => f.startsWith('.tmp-'));
    assert.equal(stragglers.length, 0, 'no .tmp- files should remain');

    // events.jsonl line count matches events/ file count
    const eventsFiles = readdirSync(join(r.dir, 'events')).filter(f => f.endsWith('.json'));
    const jsonlLines = readFileSync(join(r.dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(l => l);
    assert.equal(eventsFiles.length, jsonlLines.length, 'events.jsonl and events/ should be in sync');

    // Originator self-joined; verify by reading events
    const events = readEvents(r.dir);
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'kickoff');
    assert.equal(events[1].type, 'join');
    assert.equal(events[0].payload.transport, 'localhost');
    assert.equal(events[0].payload.tick_interval_minutes, 1);
    assert.ok(events[0].payload.min_collab_plugin_version, 'kickoff should declare a min version');

    // Simulate a peer joining and proposing-close. Use a different triplet.
    const peerTriplet = `peer@claude-code:test-machine`;
    const peerSlug = authorSlugFromTriplet(peerTriplet);
    const nowTs = new Date().toISOString();
    appendEvent(r.dir, {
      event_id: generateEventId(nowTs, peerSlug), ts: nowTs, author: peerTriplet,
      slug: r.slug, type: 'join', references: [events[0].event_id],
      payload: { capability_match: [], commitment: 'joining for test' },
    });
    appendEvent(r.dir, {
      event_id: generateEventId(nowTs, peerSlug), ts: nowTs, author: peerTriplet,
      slug: r.slug, type: 'propose-close', references: [events[0].event_id],
      payload: { synthesis: 'test synthesis', igm_met: { intention: { met: true, rationale: '' }, goal: { met: true, rationale: '' }, measure: { met: true, rationale: '' } } },
    });

    // Originator (HK in this test) runs tickDeterministic. Should detect propose-close
    // by another agent and route to 'ratify-or-object' (LLM decision needed).
    const tickResult = await tickDeterministic(r.slug, { workspaceId: 'test-e2e' });
    // The originator's triplet was set via deriveTriplet(workspaceId: 'test-e2e').
    // Since the propose came from a different author, originator must ratify or object.
    assert.equal(tickResult.action, 'agent-decision-needed');
    assert.equal(tickResult.route, 'ratify-or-object');

    // Have originator explicitly ratify; then peer's tick should converge → emit-close
    const origTriplet = events[0].author;
    const origSlug = authorSlugFromTriplet(origTriplet);
    const ratifyTs = new Date().toISOString();
    const proposeCloseEvent = readEvents(r.dir).find(e => e.type === 'propose-close');
    appendEvent(r.dir, {
      event_id: generateEventId(ratifyTs, origSlug), ts: ratifyTs, author: origTriplet,
      slug: r.slug, type: 'ratify', references: [proposeCloseEvent.event_id],
      payload: { agreement_notes: 'ok' },
    });

    // Now peer (who proposed) ticks: ratification has converged → emit-close
    const peerTick = await tickDeterministic(r.slug, { workspaceId: 'test-e2e', triplet: peerTriplet });
    assert.equal(peerTick.action, 'close');
    assert.equal(peerTick.reason, 'converged');

    // Final state: events contains a close, isClosed returns true
    const finalEvents = readEvents(r.dir);
    assert.ok(isClosed(finalEvents), 'collab should be closed after converged propose-close');

    // STATUS.md got rendered with closed state
    const status = readFileSync(join(r.dir, 'STATUS.md'), 'utf8');
    assert.ok(/closed|CLOSED/.test(status), 'STATUS.md should reflect closed state');

    // events.jsonl still in sync
    const finalJsonl = readFileSync(join(r.dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(l => l);
    assert.equal(finalJsonl.length, finalEvents.length, 'events.jsonl line count matches final event count');
  } finally {
    if (collabDir) rmSync(collabDir, { recursive: true, force: true });
  }
});
