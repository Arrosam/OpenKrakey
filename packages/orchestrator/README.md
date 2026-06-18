# Package: orchestrator

Per-Agent conductor; CONTAINS the context-buffer. Compose blocks by target (system prompt + messages array) and priority, expose buses, dispatch async, coordinate clock.

- Overview: [`../../overviews/nodes/orchestrator.md`](../../overviews/nodes/orchestrator.md)
- Implements: `orchestrator` · Depends on: `event-system`, `clock`, `context`
- Status: **pending**

Source under `src/`. Import only `../../../contracts/*` and `../../../shared/*`. Never edit contracts/ or shared/.
