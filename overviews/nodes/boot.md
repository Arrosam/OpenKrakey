# Node: boot

## Purpose
Global startup ONLY, and the composition root. Reads each Agent's config file from its personal
folder and launches each as an `agent_instance`. The one node allowed to import concrete nodes (to
wire them); contains no business logic.

## Zone
core

## Implements contracts
None.

## Depends on contracts
- `agent` — builds + starts `agent_instance`s.
- (Imports concrete nodes for wiring — the permitted composition-root exception.)

## Exposed interface
- `loadAgentConfigs(agentsDir): AgentDefinition[]` — read `agents/*/config.json`.
- `run(defs: AgentDefinition[], opts?): Promise<AgentHandle[]>` — build + start each agent_instance.
- `main(): Promise<void>` — load configs from disk, run them, keep alive. Entry point (`npm start`).

## Internal structure
DI wiring only: read config files (JSON) → for each, `createAgentInstance(def)` (wiring clock +
event-system + orchestrator + loader with `public_plugin/` + the agent's folder) → `start()`.
`isMain` guard so importing boot (in tests) does not launch.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
