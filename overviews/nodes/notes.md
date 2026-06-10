# Node: notes (plugin)

## Purpose
A persistent notes store — the roadmap's "library" example made genuinely useful. The LLM (or any
plugin) saves/reads/lists named notes as files under the plugin's `dataDir`: installed public, all
agents share one library; installed as an independent copy, the agent gets a private one. Exercises
tool dispatch, the dataDir write path, and the public-vs-independent data semantics.

## Manifest
`{ id: "notes", version: "0.1.0", requires: ["llm.register_tool"] }`

## Behavior (spec)
- setup: ensure `dataDir/notes/` exists; register three actions, then declare each as an LLM tool by
  invoking `llm.register_tool` with its ToolDef (name/description/parameters JSON schema):
  - `note.save` params `{ name: string, text: string }` → write `dataDir/notes/<name>.md`, return
    `{ saved: true, name }`. The name MUST match `/^[A-Za-z0-9._-]+$/` and not be `.`/`..` — anything
    else rejects (throws) with no filesystem write (no traversal, ever).
  - `note.read` params `{ name: string }` (same validation) → return `{ name, text }`; a missing note
    rejects with a clear error.
  - `note.list` (no params) → return `{ names: string[] }`, sorted.
- teardown: unregister the three actions (stored Unsubs).

## Status
done

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
- 2026-06-11: implemented (Phase-1 MVP wave) — edge tests + e2e loop green.
