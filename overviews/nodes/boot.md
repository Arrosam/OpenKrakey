# Node: boot

## Purpose
Global startup ONLY, and the composition root. Reads each Agent's config file, reads the global LLM
config, builds the global key-less communicator library, and launches each Agent as an
`agent_instance`. One of two nodes allowed to import concrete nodes (to wire them); contains no
business logic.

## Zone
core

## Implements contracts
None.

## Depends on contracts
- `agent` — builds + starts `agent_instance`s.
- `llm` — builds the global `CommunicatorLibrary` (via the concrete `llm-gateway` factory).
- (Imports concrete `agent_instance` + `llm-gateway` for wiring — the permitted composition-root exception.)

## Exposed interface
- `loadAgentConfigs(agentsDir): AgentDefinition[]` — read `agents/*/config.json` (skip unreadable/invalid).
- `loadLLMConfig(llmPath): LLMConfig` — read `config/llm.json` (missing/invalid → `{ communicators: {} }`).
- `run(defs, opts?: { library?, log? }): Promise<AgentHandle[]>` — build + start each agent_instance.
- `main(): Promise<void>` — load configs + llm config, build the library, run, keep alive. Entry (`npm start`).

## Internal structure
DI wiring only. `main()`: load configs → build the global library RESILIENTLY (a broken `llm.json`
falls back to an empty key-less library so agents still run — R3) → if no agents, print and return →
`run()` each (one failed start is logged and skipped) → install a SIGINT handler that
`Promise.allSettled`s every `handle.stop()` then exits. `isMain` guard (`process.argv[1]` resolved vs
`fileURLToPath(import.meta.url)`) so importing boot in tests does not launch.

## Status
done

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: implemented — reads config/llm.json, builds global communicator library, resilient startup.
- 2026-06-11: bug-fix wave — loadLLMConfig normalizes a missing communicators key; run() best-effort stop()s an agent whose start failed so partially-loaded plugins release resources.
- 2026-06-12: startupHints — friendly pre-flight (no agents -> npm run cli; no AI service -> can't-reply warning).
- 2026-06-13: startup report — startBanner, per-agent starting/started/FAILED-with-reason verdicts (themed ✦/✔/✖) through run()'s report sink, plugin starting messages indented under their agent, summaryLine started/total counts, exit 1 when every agent fails; run() passes publicPluginDir/agentsDir through.
