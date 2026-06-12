# Zone: plugins

## Purpose
The Phase-1 MVP plugin set under `public_plugin/`. Together they turn a bare agent into a usable one
— it converses in the terminal, remembers across restarts, and uses tools (including setting its own
pace) — while exercising every core function: the beat loop, context composition by priority, the
key-less LLM library, tool dispatch + `tool.result` folding, dataDir semantics (public-shared vs
independent-isolated), `provides`/`requires`, and the CLOCK_* rhythm actions.

## Rules
- Each plugin implements ONLY the L1 `plugin` contract (default export `{ manifest, setup, teardown? }`)
  and talks via the per-Agent event-system + `PluginContext`. Plugins NEVER import each other or core
  internals (R2). Imports allowed: `contracts/*`, `shared/*`, node builtins.
- Inter-plugin calls go through the actionbus. The one MVP convention: `llm-core` provides the
  `llm.register_tool` action (params: one L1 `ToolDef`); tool plugins `requires: ["llm.register_tool"]`
  and invoke it during setup. Declared plugin order in config puts `llm-core` first.
- Context block priorities: stable identity blocks 10000+ (top, cache-friendly); volatile blocks
  0–10000 (history uses 100).
- Each block-registering plugin removes its block(s) in `teardown`; each action-registering plugin
  unregisters via the stored Unsubs.

## Nodes
| Node | One-liner |
|------|-----------|
| llm-core | llm.request → communicator chat → llm.return (+ output.message); provides llm.register_tool |
| persona | stable identity block (10000+) from config |
| history | input/llm.return/tool.result → bounded transcript block + JSONL persistence in dataDir |
| console-channel | stdin → input.message + fire_now wake; prints output.message; greets on agent.start |
| notes | note.save/read/list actions over dataDir files, registered as LLM tools |
| toolbox | time.now + ToolDefs for the orchestrator's clock rhythm actions (LLM self-pacing) |

## Change log
- 2026-06-13: all six plugins flipped to the PluginFactory shape (per-Agent instances); data-carrying plugins (history, notes) are privatePlugins in the default setting so each agent owns its memory/notes.
- 2026-06-13: plugin contract v1.1 adoption — console-channel greets via ctx.print; llm-core/notes/toolbox warn via ctx.log.warn.
