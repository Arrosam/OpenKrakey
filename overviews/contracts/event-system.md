# Contract: event-system

## Purpose
The per-Agent communication substrate: a pub/sub event bus + a register/invoke action bus. The only
sanctioned channel between plugins and between plugins and the core.

## Connects
event-system (impl) ↔ orchestrator, loader, agent_instance (consumers; plugins use it too)

## Interface definition
- EventBus: `emit(event, payload?)`; `on(event, handler) → Unsub`.
- ActionBus: `register(action, handler) → Unsub`; `invoke(action, params?) → Promise`; `has(action)`; `list()`.
- `EventSystem` exposes `.events` and `.actions`.

## Behavioral constraints
- `emit` to no listeners = no-op (never throws); a throwing listener does not stop the others.
- `invoke` on an unregistered action rejects. Duplicate `register` of a name rejects (surface conflict).
- `on`/`register` return stale-safe unsubscribes.

## Status
locked
