/**
 * class-19-gap.test.mjs — the one case of DG3 class 19 that no existing test covers.
 *
 * Class 19 enumerates four sources for a foreign events.jsonl event:
 *   (a) an author with no join at all      → covered by test-collab-wp4-attacks.mjs "A3 … never joined"
 *   (b) an author who withdrew first        → covered (weakly) by "H3 … after withdrawal"
 *   (c) an author whose JOIN ITSELF FAILED  → NOT COVERED anywhere. This file.
 *   (d) a legitimate author (the control)   → covered by "A3 … still imports, beside a rejected one"
 *
 * The design's admission-policy concept does not exist in the implementation, so (c) is
 * exercised here through its only reachable analogue: a join event that failed v1 validation
 * and was quarantined. A quarantined join is dot-prefixed and therefore invisible to
 * readEvents — so it must not admit anyone. If membership were ever computed from a raw
 * directory scan (or from the foreign event's own author field), a peer could get itself
 * admitted by a join that the channel already rejected.
 *
 * Run:  node --test class-19-gap.test.mjs
 * Against a mutated tree:  COLLAB_SRC=/path/to/skills/collab/scripts node --test class-19-gap.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SRC = process.env.COLLAB_SRC
  || '/Users/dbates/Documents/Projects/collab-plugin/skills/collab/scripts';

const { appendEvent, readEvents, reconcileForeignSurface } =
  await import(join(SRC, 'collab-event-helpers.mjs'));
const { quarantineInvalidV1Events } =
  await import(join(SRC, 'collab-v1-quarantine.mjs'));

const SLUG = 'class19-admission-channel';
const OWNER = 'core-framework@claude-code:host';
const REJECTED = 'core-gemini@gemini:host';   // joins, but the join is rejected

const ev = (id, author, type, payload, ts) => ({
  event_id: id, ts, author, slug: SLUG, type, references: [], payload,
});

test('class 19 (c): an author whose join failed validation must not be authorized to auto-import', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-class19-'));
  mkdirSync(join(dir, 'events'), { recursive: true });
  try {
    const kick = ev('evt-kick', OWNER, 'kickoff', { message: 'k' }, '2026-07-30T04:00:00.000Z');
    appendEvent(dir, kick);

    // A v1 join that does NOT satisfy the channel's validation contract: it declares
    // schema_version 1.0 and omits provenance. This is the admission failure.
    const badJoin = ev('evt-rejected-join', REJECTED, 'join', {
      schema_version: '1.0', capability_match: [], commitment: 'joining',
    }, '2026-07-30T04:05:00.000Z');
    appendEvent(dir, badJoin);

    const report = quarantineInvalidV1Events(dir, { author: OWNER });
    assert.ok(
      report.quarantined.some(q => q.event_id === 'evt-rejected-join'),
      'setup precondition failed: the invalid join was not quarantined, so this test would not ' +
      'be exercising a rejected join at all',
    );

    // The rejected member now writes straight to the legacy surface.
    const smuggled = ev('evt-smuggled-0001', REJECTED, 'turn', {
      intent: 'propose', body: 'I ACCEPT — counted as a member on a join the channel rejected', signals: [],
    }, '2026-07-30T04:10:00.000Z');
    const canonicalLines = readEvents(dir).map(e => JSON.stringify(e));
    writeFileSync(
      join(dir, 'events.jsonl'),
      [...canonicalLines, JSON.stringify(smuggled)].join('\n') + '\n',
    );

    const r = reconcileForeignSurface(dir, OWNER);

    assert.ok(
      !r.imported.includes('evt-smuggled-0001'),
      'imported a foreign event from an author whose only join was rejected — a join the channel ' +
      'refused still conferred membership',
    );
    assert.ok(
      r.escalated.some(x => x.event_id === 'evt-smuggled-0001' && /author|join|member|authoriz/i.test(x.reason)),
      'the rejected-join author was neither imported nor escalated with a membership reason',
    );
    // Assert on the store, not only the return value.
    assert.ok(
      !readEvents(dir).some(e => e.event_id === 'evt-smuggled-0001'),
      'the smuggled event reached the canonical ledger',
    );
    // And the rejected join is still preserved on disk — refusing admission must not destroy bytes.
    assert.ok(
      readdirSync(join(dir, 'events')).some(f => f.startsWith('.quarantined-evt-rejected-join')),
      'the rejected join was discarded rather than preserved for review',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
