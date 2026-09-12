/**
 * test-collab-peer-silence-terminal-mode.mjs — DG3 failure class 18.
 *
 * 18: peer silence runs the ladder to an HONEST terminal mode.
 *
 * Setup is three participants where one never posts a design turn, and that
 * participant's review is itself a ratified completion measure. Running past the
 * deadline, the grace window, the chase sequence, and a recovery attempt must
 * terminate as `complete-to-authority-boundary` or `failed-safely`. It must not
 * terminate `complete` (collab spells this `converged`) and must not terminate
 * `completed-degraded-review`, because a degraded terminal mode is permitted only
 * when the missing review is NOT itself a ratified measure. And it must not
 * synthesize the missing accept.
 *
 * Live motivation: this is the exact state the 2026-07-30 session was in. A third
 * agent joined, never delivered its review, and the only thing that moved the goal
 * was a human noticing. The failure was not a crash — it was a ledger that could
 * describe the outcome only as "converged."
 *
 * Mechanism seam this test pins: a ratified completion measure that names a
 * reviewing participant is declared on the kickoff as
 *   payload.ratified_completion_measures: [{ id, description, requires_review_from }]
 * Silence-as-ratification (README §3) is a deliberate, ratified feature and must keep
 * working for every participant NOT named this way — the control case below asserts
 * exactly that. What class 18 forbids is applying it to a participant whose review is
 * the measure, because there the silence is the missing evidence, not consent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  appendEvent, readEvents,
  getRatificationStatus, evaluateObligations, executeTimeoutAction, checkSafetyNets,
  CHASE_FLOOD_LIMIT,
} from '../skills/collab/scripts/collab-event-helpers.mjs';
import { detectRoute, tickDeterministic } from '../skills/collab/scripts/collab-tick.mjs';
import { validateEvents } from '../skills/collab/scripts/collab-validate.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
// Participant identity is minted to disk on first use. Bind it to a throwaway root for
// this test process so a run never mints — or pins — an identity in the real ~/.collab.
process.env.COLLAB_STATE_ROOT = mkdtempSync(join(tmpdir(), 'collab-state-'));

const ME = 'core-framework@claude-code:host';   // canonical writer / proposer
const PEER_A = 'core-codex@codex:host';         // delivers, reviews, ratifies
const PEER_B = 'core-gemini@antigravity:host';  // joins, then never posts a design turn

const MEASURE_ID = 'DG1-independent-review';

// Terminal modes the design permits when a ratified review never arrives.
const HONEST_TERMINAL_MODES = ['complete-to-authority-boundary', 'failed-safely'];
// `complete` is the design's word; `converged` is collab's spelling of the same claim.
const FORBIDDEN_TERMINAL_MODES = ['complete', 'converged', 'completed-degraded-review'];

const LOCAL_COLLAB_ROOT = join(homedir(), '.collab', 'local');
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60 * 1000;

/**
 * Build a channel on disk. Time is driven by backdating event timestamps relative to
 * a caller-supplied T0 and by injecting `nowTs` into the pure query functions — no
 * test waits on real elapsed time.
 */
function mkChannel(slug, T0, { requireReviewFromB = true } = {}) {
  const dir = join(LOCAL_COLLAB_ROOT, `2026-07-30-${slug}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'events'), { recursive: true });

  const kickoffPayload = {
    message: 'harden the comms protocol',
    transport: 'localhost',
    igm: { intention: 'i', goal: 'g', measure: 'three independent accepts' },
    capabilities_wanted: [],
    wall_clock_hours: 24,
    tick_interval_minutes: 10,
    ratification_window_minutes: 5,
  };
  if (requireReviewFromB) {
    kickoffPayload.ratified_completion_measures = [{
      id: MEASURE_ID,
      description: 'independent review by the third participant',
      requires_review_from: PEER_B,
    }];
  }
  appendEvent(dir, {
    event_id: 'evt-001', ts: iso(T0), author: ME, slug, type: 'kickoff',
    references: [], payload: kickoffPayload,
  });

  let n = 2;
  const ev = (author, type, atMs, payload, references = []) => {
    appendEvent(dir, {
      event_id: `evt-${String(n++).padStart(3, '0')}`,
      ts: iso(atMs), author, slug, type, references, payload,
    });
  };

  ev(ME, 'join', T0, { capability_match: [], commitment: 'own the design' });
  ev(PEER_A, 'join', T0 + 1 * MIN, { capability_match: [], commitment: 'independent review' });
  ev(PEER_B, 'join', T0 + 2 * MIN, { capability_match: [], commitment: 'independent review' });

  // A real design turn from ME and from PEER_A.
  ev(ME, 'turn', T0 + 10 * MIN, {
    intent: 'propose', body: 'full design, sections 1-16', signals: [],
    state: 'working', owner: ME, waiting_on: PEER_B,
    next_update_by: iso(T0 + 40 * MIN), on_timeout: 'degrade-and-continue', work_packet: 'WP-design',
  });
  ev(PEER_A, 'turn', T0 + 12 * MIN, {
    intent: 'critique', body: 'independent critique with four falsifiers', signals: [],
    state: 'working', owner: PEER_A, waiting_on: ME,
    next_update_by: iso(T0 + 40 * MIN), on_timeout: 'degrade-and-continue', work_packet: 'WP-review-a',
  });

  // PEER_B: an acknowledgement with a committed deadline, and then nothing. This is
  // "never posts a design turn" — the lane was accepted and never delivered, which is
  // what makes the deadline/grace/chase ladder reachable at all.
  ev(PEER_B, 'turn', T0 + 5 * MIN, {
    intent: 'clarify', body: 'acknowledged; independent review to follow', signals: ['ack'],
    state: 'working', owner: PEER_B, waiting_on: PEER_B,
    next_update_by: iso(T0 + 20 * MIN), on_timeout: 'degrade-and-continue', work_packet: 'WP-review-b',
  });

  // Deadline lapses, grace elapses, the chase sequence runs to exhaustion.
  for (let i = 0; i < CHASE_FLOOD_LIMIT; i++) {
    ev(ME, 'turn', T0 + (30 + i * 5) * MIN, {
      intent: 'clarify', body: `Obligation missed: ${PEER_B} owes the independent review.`,
      signals: ['chase', 'obligation-missed', PEER_B],
      state: 'blocked', owner: PEER_B, waiting_on: PEER_B, next_update_by: '',
    });
  }

  return { dir, slug, nextIdx: () => n };
}

/** Append the propose-close and PEER_A's ratify. PEER_B stays silent from here. */
function proposeAndPartiallyRatify(dir, slug, T0) {
  appendEvent(dir, {
    event_id: 'evt-100', ts: iso(T0 + 60 * MIN), author: ME, slug, type: 'propose-close',
    references: [], payload: { synthesis: 'design converged between two of three', igm_met: {} },
  });
  appendEvent(dir, {
    event_id: 'evt-101', ts: iso(T0 + 62 * MIN), author: PEER_A, slug, type: 'ratify',
    references: ['evt-100'], payload: {},
  });
}

function cleanup(slug) {
  const dir = join(LOCAL_COLLAB_ROOT, `2026-07-30-${slug}`);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ vocabulary

test('18: the honest terminal modes are expressible as close outcomes', () => {
  const mk = (outcome) => ({
    event_id: 'evt-x', ts: iso(Date.now()), author: ME, slug: 's', type: 'close',
    references: [], payload: { final_synthesis: 'done', outcome },
  });
  for (const outcome of HONEST_TERMINAL_MODES) {
    const r = validateEvents([mk(outcome)]);
    assert.ok(
      r.valid,
      `a close carrying the honest terminal mode "${outcome}" was rejected as invalid ` +
      `(${r.errors.join('; ')}). A protocol with no vocabulary for an honest terminal mode ` +
      'can only ever record success or an abort, which is the exact lie class 18 forbids.',
    );
  }
});

// -------------------------------------------------- no synthesized third accept

test('18: silence from a required reviewer is never converted into ratification', () => {
  const slug = 'class18-no-synth-accept';
  const T0 = Date.now() - 90 * MIN;
  const { dir } = mkChannel(slug, T0);
  try {
    proposeAndPartiallyRatify(dir, slug, T0);
    const events = readEvents(dir);

    // Far past the ratification window (5 min declared; 30 min elapsed) and past any
    // plausible extension of it.
    const status = getRatificationStatus(events, iso(T0 + 600 * MIN));
    assert.ok(status, 'no ratification status for an active propose-close');

    assert.ok(
      !status.implicitRatified.includes(PEER_B),
      `${PEER_B}'s silence was converted into an implicit ratification while their review ` +
      `is a ratified completion measure (${MEASURE_ID}). That is a synthesized third accept: ` +
      'the missing evidence became the consent to close without it.',
    );
    assert.ok(
      !status.ratified.includes(PEER_B),
      `${PEER_B} appears in the ratified set without ever having ratified.`,
    );
    assert.ok(
      status.pending.includes(PEER_B),
      `${PEER_B} owes a ratified measure and must stay pending, not disappear from the ledger.`,
    );
    assert.equal(
      status.converged, false,
      'the collab reported convergence while a ratified completion measure had no evidence ' +
      'receipt. Two of three accepts is a consensus candidate, never a ratified design.',
    );
  } finally { cleanup(slug); }
});

test('18: control — silence from a peer who is NOT a ratified measure still ratifies', () => {
  const slug = 'class18-control-silence-ok';
  const T0 = Date.now() - 90 * MIN;
  const { dir } = mkChannel(slug, T0, { requireReviewFromB: false });
  try {
    proposeAndPartiallyRatify(dir, slug, T0);
    const status = getRatificationStatus(readEvents(dir), iso(T0 + 600 * MIN));
    assert.ok(
      status.implicitRatified.includes(PEER_B),
      'silence-as-ratification stopped working for an ordinary peer. Class 18 narrows that ' +
      'rule to participants whose review is a ratified measure; it does not repeal it, and a ' +
      'blanket "silence never ratifies" would strand every offline peer forever.',
    );
    assert.equal(status.converged, true, 'an ordinary silent peer must not block convergence');
  } finally { cleanup(slug); }
});

// ------------------------------------------------------------------- the ladder

test('18: the ladder is genuinely exhausted before any terminal claim', () => {
  const slug = 'class18-ladder-exhausted';
  const T0 = Date.now() - 90 * MIN;
  const { dir } = mkChannel(slug, T0);
  try {
    // Deadline + grace + three chases already on the ledger. The declared on_timeout
    // must now be due — this is the recovery attempt, not another chase.
    const obl = evaluateObligations(readEvents(dir), { now: T0 + 55 * MIN, self: ME });
    const forB = obl.due.find(d => d.participant === PEER_B);
    assert.ok(forB, `no obligation came due for ${PEER_B} despite a lapsed deadline and grace`);
    assert.equal(
      forB.action, 'degrade-and-continue',
      `after ${CHASE_FLOOD_LIMIT} chases the declared on_timeout must become due, got ` +
      `${forB.action}. Chasing forever is the silent stall this class exists to prevent.`,
    );

    const executed = executeTimeoutAction(dir, forB, ME);
    assert.ok(executed, 'the recovery step was computed but never executed');
    assert.ok(
      readEvents(dir).some(e => e.type === 'timeout-action'),
      'the recovery attempt left no routed record',
    );
  } finally { cleanup(slug); }
});

test('18: routing must not head for a converged close while a ratified review is missing', () => {
  const slug = 'class18-route-guard';
  const T0 = Date.now() - 90 * MIN;
  const { dir } = mkChannel(slug, T0);
  try {
    proposeAndPartiallyRatify(dir, slug, T0);
    // Chosen so the ratification window (5 min) has long elapsed while no safety net is
    // armed. Without this the test passes on `safety-net:stall`, which proves nothing
    // about the guard — it only proves the channel went quiet.
    const now = iso(T0 + 100 * MIN);
    const events = readEvents(dir);
    assert.equal(
      checkSafetyNets(events, now), null,
      'test setup drifted: a safety net is armed at this instant, so the route below would ' +
      'not exercise the ratification guard at all',
    );

    assert.notEqual(
      detectRoute(events, ME, now), 'emit-close',
      'the tick routed to emit-close, which writes outcome "converged". The proposer is ' +
      `about to record full success while ${PEER_B}'s review — a ratified completion ` +
      'measure — has no evidence receipt at all.',
    );
  } finally { cleanup(slug); }
});

// --------------------------------------------------- A1/A2: the terminal record

test('18: end to end, the goal terminates in an honest mode — and terminates', async () => {
  const slug = 'class18-terminal-mode';
  const T0 = Date.now() - 90 * MIN;
  const { dir } = mkChannel(slug, T0);
  try {
    proposeAndPartiallyRatify(dir, slug, T0);
    const before = readEvents(dir).length;

    const result = await tickDeterministic(slug, { triplet: ME, workspaceId: 'test', dryRun: false });

    const after = readEvents(dir);

    // A2 asserted positively: something terminal or explicitly degraded must exist.
    // "Nothing happened" is the failure mode, not a pass.
    assert.ok(
      after.length > before,
      'the tick produced no event at all. A goal blocked on a missing ratified review that ' +
      'emits nothing is the silent stall class 18 is named for — the only thing that moves ' +
      'it then is a human noticing.',
    );

    const close = after.find(e => e.type === 'close');
    assert.ok(
      close,
      `the ladder ran out with no terminal record (tick action: ${result.action}). The goal ` +
      'must either heal or emit an explicit, recorded, deadline-bearing failure state.',
    );

    const outcome = close.payload?.outcome;

    // A2: the two dishonest exits.
    assert.ok(
      !FORBIDDEN_TERMINAL_MODES.includes(outcome),
      `the goal terminated as "${outcome}". ` +
      (outcome === 'converged' || outcome === 'complete'
        ? `That claims full success while ${PEER_B} never delivered the review that is a ` +
          'ratified completion measure, and while no third accept was ever emitted.'
        : 'A degraded terminal mode is permitted only when the missing review is NOT itself ' +
          'a ratified completion measure. Here it is, so degradation cannot waive it.'),
    );

    // A1: the honest exits.
    assert.ok(
      HONEST_TERMINAL_MODES.includes(outcome),
      `expected one of ${HONEST_TERMINAL_MODES.join(' | ')}, got "${outcome}".`,
    );

    // No third accept may be fabricated on the way out.
    assert.ok(
      !after.some(e => e.type === 'ratify' && e.author === PEER_B),
      `a ratify attributed to ${PEER_B} appeared in the ledger. ${PEER_B} emitted nothing; ` +
      'the accept was fabricated.',
    );
    assert.ok(
      !(close.payload?.ratified_by || []).includes(PEER_B),
      `the close event counts ${PEER_B} among the ratifiers without a ratify event.`,
    );

    // The terminal record has to name what is missing, or it is not honest — it is
    // just a different word for the same silence.
    const text = JSON.stringify(close.payload);
    assert.ok(
      text.includes(PEER_B) || text.includes(MEASURE_ID),
      'the close names neither the missing participant nor the unmet ratified measure. ' +
      'An honest terminal mode has to identify exactly what did not arrive.',
    );
  } finally { cleanup(slug); }
});
