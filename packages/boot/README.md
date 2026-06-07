# Package: boot

Global startup only: read each agent's config file and launch each agent_instance. Composition root.

- Overview: [`../../overviews/nodes/boot.md`](../../overviews/nodes/boot.md)
- Implements: — · Depends on: `agent` (+ imports concrete nodes, as the composition-root exception)
- Status: **pending**

Source under `src/`. The one node permitted to import concrete node implementations (to wire them via DI).
