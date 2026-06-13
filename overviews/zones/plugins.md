# Zone: plugins

## Purpose
The MVP plugin set under `public_plugin/`. Together they turn a bare agent into a usable one
— it converses in the browser, remembers across restarts, and uses tools (including setting its own
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
| web | refcounted http hub: POST /message → input.message + fire_now; SSE stream of output.message; sent/read status; serves the chat page |
| notes | note.save/read/list actions over dataDir files, registered as LLM tools |
| toolbox | time.now + ToolDefs for the orchestrator's clock rhythm actions (LLM self-pacing) |
| inspector | read-only debug dashboard: own refcounted loopback+token http hub + per-agent SSE; bounded in-memory record ring of ALL bus events; shows prompts sent/received, the event timeline, and logs (incl. core:*), correlated per-beat by request id; emits nothing |

## Change log
- 2026-06-13: all six plugins flipped to the PluginFactory shape (per-Agent instances); data-carrying plugins (history, notes) are privatePlugins in the default setting so each agent owns its memory/notes.
- 2026-06-13: plugin contract v1.1 adoption — console-channel greets via ctx.print; llm-core/notes/toolbox warn via ctx.log.warn.
- 2026-06-13: console-channel (terminal chat) removed; web (browser chat) is the channel — refcounted http hub, per-agent SSE isolation (R6), sent/read delivery status; the e2e loop now drives through web HTTP.
- 2026-06-14: inspector added — a read-only observability sibling of web (own refcounted loopback+token http hub, per-agent SSE, bounded in-memory record ring of all bus events; dependency-free dashboard for prompts/event-timeline/logs, correlated by request id). Pairs with a core-log-to-bus bridge in agent_instance so the Logs feed also carries core:orchestrator/core:loader diagnostics.
