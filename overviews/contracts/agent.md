# Contract: agent

## Purpose
Defines an Agent's config file shape and its external runtime handle.

## Connects
agent_instance (impl) ↔ boot, cli (consumers)

## Interface definition
- `AgentDefinition` = `{ id, intervalMs, plugins: string[], privatePlugins?: string[], config? }`.
- `AgentHandle` = `{ id, start(): Promise<void>, stop(): Promise<void> }`.
- `Agent extends AgentHandle`.

## Behavioral constraints
- `plugins` = public plugin ids (shared); `privatePlugins` = ids to load as independent copies (private data).
- `start` brings up the Agent (load plugins → conduct); `stop` tears it down; both idempotent-safe.
- `config[pluginId]` is passed to that plugin as its `PluginContext.config`.

## Status
locked
