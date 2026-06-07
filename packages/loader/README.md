# Package: loader

Per-Agent plugin lifecycle: copy independents, load private(override)+public, set dataDir, register (setup) into event-system, teardown.

- Overview: [`../../overviews/nodes/loader.md`](../../overviews/nodes/loader.md)
- Implements: `loader` · Depends on: `plugin`, `event-system`, `context`, `orchestrator`
- Status: **pending**

Source under `src/`. Import only `../../../contracts/*` and `../../../shared/*`. Never edit contracts/ or shared/.
