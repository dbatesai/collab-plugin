# IGM derivation template

Used at kickoff to derive IGM from David's message.

## Fields

```yaml
igm:
  intention: "Why this matters — the underlying concern"
  goal: "Concrete artifact or decision the collab produces"
  measure: "How done is detected. Must name what would NOT satisfy."
```

## Algorithm

1. **Intention** — What is David actually worried about? Look for the concern behind the request.
2. **Goal** — What concrete thing lands? Be specific: a go/no-go decision, a change list, a validated plan.
3. **Measure** — How do we know we're done? Must name what would NOT satisfy.

## Placeholder pattern

If the message is too vague for a concrete measure, write:

```yaml
measure: "(measure inferred as 'reasonable consensus on goal'; refine in first turn)"
```

Joined agents can sharpen the IGM via `turn` with `intent: clarify` in their first tick.

## Good example

```yaml
intention: "Validate that DC-85 Phase 1b meets design goals before v2.3 release"
goal: "Explicit go/no-go on IGM compliance, with a change list if no-go"
measure: "Per-dimension boolean + rationale from each participant. NOT satisfied by: vague agreement or 'looks good' without specifics."
```
