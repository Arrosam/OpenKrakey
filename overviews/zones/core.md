# Zone: core

## Purpose
The entire OpenKrakey framework (≤10 nodes → one zone): the per-Agent runtime modules, the two
global modules (boot, cli), and the seven L1 contracts that connect them.

## Nodes
| Node | Purpose | Status |
|------|---------|--------|
| clock | Per-Agent dumb timer | pending |
| event-system | Per-Agent central eventbus + actionbus | pending |
| orchestrator | Per-Agent conductor (contains context-buffer) | pending |
| loader | Per-Agent plugin load/register/teardown | pending |
| agent_instance | Wraps one Agent (clock+event-system+orchestrator+loader) | pending |
| boot | Global startup (launch agents from config files) | pending |
| cli | Global config-file management UI | pending |

## Internal contracts
All seven are internal to this zone (single-zone project): clock, event-system, context, plugin,
orchestrator, agent, loader.

## External contracts
None — single zone.

## Dependencies on other zones
None.
