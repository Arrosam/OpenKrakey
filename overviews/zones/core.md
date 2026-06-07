# Zone: core

## Purpose
The entire OpenKrakey framework (≤10 nodes → one zone): the per-Agent runtime modules, the three
global modules (boot, cli, llm-gateway), and the eight L1 contracts that connect them.

## Nodes
| Node | Purpose | Status |
|------|---------|--------|
| clock | Per-Agent dumb timer (default/current interval) | pending |
| event-system | Per-Agent central eventbus + actionbus | pending |
| orchestrator | Per-Agent conductor (contains context-buffer) | pending |
| loader | Per-Agent plugin load/register/teardown (injects llm library) | pending |
| agent_instance | Wraps one Agent (clock+event-system+orchestrator+loader) | pending |
| boot | Global startup (launch agents from config; builds global llm library) | pending |
| cli | Global interactive config UI | pending |
| llm-gateway | Global LLM communication gateway (key-less communicator library) | pending |

## Internal contracts
All eight are internal to this zone (single-zone project): clock, event-system, context, plugin,
orchestrator, agent, loader, llm.

## External contracts
None — single zone.

## Dependencies on other zones
None.
