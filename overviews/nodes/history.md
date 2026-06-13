# Node: history (plugin)

## Purpose
Conversation memory. Folds the agent's dialogue — user input, assistant replies (with their tool
calls), and tool results — into a bounded, low-priority context block so every beat sees the
conversation so far, and persists it as JSONL under `dataDir` so it survives restarts. Public install
= shared memory across agents; `privatePlugins` install = agent-isolated memory (R6 demo).

## Manifest
`{ id: "history", version: "0.1.0" }`

## Config slice (`config["history"]`)
`{ maxEntries?: number }` — default 200; the block renders (and memory keeps) at most this many entries.

## Behavior (spec)
- setup: ensure `dataDir` exists; load up to `maxEntries` tail entries from `dataDir/history.jsonl`
  (ignore unparseable lines); register block `{ id: "history", priority: 100 }` rendering
  `"## Conversation"` followed by one line per entry, oldest first:
  - `input.message` (`Notify<{text}>`) → entry `user: <text>`
  - `llm.return` (`Reply<LLMResponse>`, only when `ok` && `data`) → entry `assistant: <content>`; when
    `data.toolCalls` is non-empty also one entry per call: `assistant -> tool: <name>(<JSON args>)`
  - `tool.result` (`Reply & {name}`) → entry `tool <name> -> <JSON data>` on ok, `tool <name> !! <error>`
    on failure
- Every appended entry is also appended to `dataDir/history.jsonl` as one JSON line (shape: `{ at,
  kind, text }` — `kind` ∈ user|assistant|tool_call|tool_result). Malformed event payloads are ignored
  without throwing.
- A fresh setup over the same dataDir re-renders previously persisted entries (memory across restarts).
- teardown: `ctx.removeBlock("history")`, unsubscribe all listeners.

## Status
done

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
- 2026-06-11: implemented (Phase-1 MVP wave) — edge tests + e2e loop green.
