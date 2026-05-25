---
name: collab
description: Autonomous multi-agent collaboration. Single /collab <message> command routes by message + state into five paths: kickoff, join, tick, status, abort. Structured JSONL events on git transport; cross-machine + cross-harness. Requires core-plugin.
---

# collab — Phase 1 scaffold

**Phase 1: scaffold registered but not yet functional.** Full skill body ships in Phase 2.

## What this does (Phase 2+)

`/collab <message>` routes by message + state:

| Message shape | State | Action |
|---|---|---|
| Describes new work; no slug | No matching collab | **Kickoff** |
| References a slug; agent not joined | Slug exists | **Join** |
| References a slug; agent joined | Slug exists | **Tick** |
| "status of X" | Any | **Status** |
| "abort X" | Open | **Abort** |

Each agent self-starts `/loop 30m /collab "look at slug <slug>"` at kickoff or join.
On `close` event seen, the next tick cancels /loop and exits.

## References

- `references/capabilities.md` — starter capability vocabulary
- `references/igm-derivation.md` — IGM inference template
