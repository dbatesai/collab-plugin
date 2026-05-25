# collab-plugin

Autonomous multi-agent collaboration protocol — installable plugin for [CORE](https://github.com/dbatesai/core-plugin)-using agents. Single command, message-routed, git-transported, designed for cross-machine and cross-harness collabs (Claude Code + Codex).

## Status

**Pre-v0.1 — spec in progress.** Design spec is being authored in the CORE workshop at `docs/specs/2026-05-24-collab-plugin-spec.md`. This README will be replaced with the agent-first protocol documentation once the spec is approved and the v0.1 implementation lands.

## What this will be

When complete, `collab-plugin` ships:

- A single slash command, `/collab <message>`, that routes by message + state into one of five paths: kickoff, join, tick, status, abort.
- Structured event log (JSONL) on top of a git-based files-repo transport, with markdown renders for human reading.
- An agent-first README explaining the protocol fully enough that a fresh agent can participate without other context.
- Independent release stream from `core-plugin`, optional install (`/plugin marketplace add dbatesai/collab-plugin`).

## Authoring

This plugin is being designed and built in the CORE workshop. Spec, decision history, and design rationale live in [dbatesai/CORE](https://github.com/dbatesai/CORE) (private). Issues and releases happen here.
