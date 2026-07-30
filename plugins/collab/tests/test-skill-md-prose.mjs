import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(__dirname, '..', 'skills', 'collab', 'SKILL.md');
const SKILL = readFileSync(SKILL_PATH, 'utf8');

test('SKILL.md mentions signals: [] in payload examples', () => {
  // Without this, agents read "signals: string array of optional hints" and omit it
  assert.ok(
    SKILL.includes('signals: []') || SKILL.includes('signals":[]') || SKILL.includes("signals: ['"),
    'SKILL.md should show an explicit "signals: []" or "signals: [...]" in at least one payload example'
  );
});

test('SKILL.md distinguishes body (turn) from synthesis (propose-close)', () => {
  // Both fields must be mentioned; the distinction must be discoverable
  assert.ok(SKILL.includes('body'), 'SKILL.md must mention "body" field');
  assert.ok(SKILL.includes('synthesis'), 'SKILL.md must mention "synthesis" field');
});

test('SKILL.md mentions all 5 valid turn intents', () => {
  const intents = ['propose', 'critique', 'probe', 'synthesize', 'clarify'];
  for (const intent of intents) {
    assert.ok(SKILL.includes(intent), `SKILL.md should mention intent "${intent}"`);
  }
});

test('SKILL.md mentions all 5 close outcomes', () => {
  const outcomes = ['converged', 'aborted-stall', 'aborted-budget', 'aborted-objection', 'aborted-david'];
  for (const outcome of outcomes) {
    assert.ok(SKILL.includes(outcome), `SKILL.md should mention outcome "${outcome}"`);
  }
});

test('SKILL.md mentions the 5 routes', () => {
  for (const route of ['kickoff', 'join', 'tick', 'status', 'abort']) {
    assert.ok(SKILL.includes(route), `SKILL.md should mention route "${route}"`);
  }
});
