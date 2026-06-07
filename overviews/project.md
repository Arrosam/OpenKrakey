# OpenKrakey

## Purpose
A minimalist **microkernel** autonomous-agent framework (TypeScript/Node). The runtime is
domain-agnostic — it knows only **time-driven activation**, an **event/action bus**, **context
composition**, and **plugin loading**. An "Agent" is an independent instance: a bundle of plugins
running on a heartbeat. All capability (LLM, memory, prompt/context blocks, tools, channels) lives
in plugins.

## Architecture
**Global:** `boot` (startup only — read each agent's config + `config/llm.json`, build the global
LLM library, launch each agent), `cli` (a standalone interactive config UI), and `llm-gateway` (builds
a key-less LLM communicator library from config — keys stay in core, plugins only get the library).
**Per-Agent** (one set per Agent, wrapped by `agent_instance`):
`clock` (dumb timer) · `event-system` (independent central eventbus + actionbus) · `orchestrator`
(the conductor; **contains the context-buffer**; composes context by block `priority`, exposes the
buses, dispatches LLM-parsed tool calls async, coordinates the clock) · `loader` (loads/registers
this Agent's plugins). Plugins talk only through the per-Agent event-system + L1 contracts; Agents
are isolated. Full design in `ARCHITECTURE.md`.

## Zones
| Zone | Purpose | Nodes |
|------|---------|-------|
| core | The whole framework | clock, event-system, orchestrator, loader, agent_instance, boot, cli, llm-gateway |

## Shared modules
| Module | Purpose |
|--------|---------|
| actions | Well-known event/action names + payload shapes (Notify/Request/Reply + EventPayloads) |
| errors | Common error types |
| logging | Minimal logger interface + console impl |
| config | Config/setting types (incl. LLMConfig) + canonical path constants |

## Key contracts
| Contract | Connects | Purpose |
|----------|----------|---------|
| clock | clock ↔ orchestrator, agent_instance | Dumb timer (default/current interval; immediate setInterval) |
| event-system | event-system ↔ orchestrator, loader, agent_instance | eventbus + actionbus (central bus) |
| context | orchestrator, loader | ContextBlock {id, priority, render} + ComposedContext |
| plugin | loader, orchestrator | Plugin / PluginContext (dataDir + key-less llm library + block ops by id) |
| orchestrator | orchestrator ↔ agent_instance, loader | Conductor surface + block store |
| agent | agent_instance ↔ boot, cli | AgentDefinition / AgentHandle / Agent |
| loader | loader ↔ agent_instance | Per-Agent plugin load/teardown (injects llm library) |
| llm | llm-gateway ↔ orchestrator, loader, plugins | LLM I/O envelope + key-less Communicator/Library (infra) |
