# Node: event-system

## Purpose
The per-Agent independent central bus: an **eventbus** (publish/subscribe) + an **actionbus**
(registerable, invokable operations). Clock (tick), loader (plugin wiring), orchestrator
(subscribe/dispatch) and all plugins connect here. Kept independent because so many parts plug in.

## Zone
core

## Implements contracts
- `event-system` — `EventBus`, `ActionBus`, `EventSystem`.

## Depends on contracts
None.

## Exposed interface
- `createEventSystem(): EventSystem` (factory).
- EventBus: `emit(event, payload?)` / `on(event, handler) → Unsub`.
- ActionBus: `register(action, handler) → Unsub` / `invoke(action, params?) → Promise` / `has` / `list`.

## Internal structure
Map of event→listeners (emit isolates per-listener errors; no-op on no listeners) and map of
action→handler (`invoke` rejects unknown; duplicate `register` rejected; stale-safe unsubscribes).

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
