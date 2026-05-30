# Capability vocabulary

Starter list for `<workspace>/_collab/capabilities.yaml`. Agents extend freely.
This is a hint vocabulary, not a controlled enumeration.

## Core

| Tag | Meaning |
|---|---|
| `architecture-design` | System architecture and protocol design |
| `code-review` | Implementation reading and critique |
| `empirical-probe` | Running tests, reporting actual behavior |
| `synthesis` | Integrating multiple perspectives into a coherent summary |
| `domain-research` | External tools, papers, or standards research |

## CORE-ecosystem

| Tag | Meaning |
|---|---|
| `core-development` | CORE plugin + skill development |
| `bblens-context` | BBLens overlay + T-Mobile broadband product context |
| `codex-behavior` | Codex harness-specific behavior and limitations |
| `windows-testing` | Windows runtime validation, path-separator testing |
| `external-source-access` | Can pull from external APIs or document stores |

## Example `capabilities.yaml`

```yaml
triplet: core-framework@claude-code:home
capabilities:
  core-development: CORE plugin development, skill editing, memory architecture
  architecture-design: Protocol design, schema design, ADR authoring
  synthesis: Multi-agent output integration and ratification reasoning
```

To add new tags: add to your local `capabilities.yaml`. If the tag seems broadly useful, open a PR here.
