/**
 * Node: agent_instance — the per-Agent runtime unit (composition root).
 *
 * Wraps & runs ONE Agent: it constructs that Agent's independent set (clock,
 * event-system, orchestrator, loader) once at construction, performs the only
 * wiring this node owns — bridging each clock activation onto the event-system as
 * a `clock.tick` event — and sequences startup/shutdown. It holds no business
 * logic: conducting the beat is the orchestrator's job and plugin startup is the
 * loader's. This is the one node permitted to import the concrete sibling
 * factories (composition-root exception); every other coupling stays behind a
 * contract.
 */
import path from "node:path";

import { createClock } from "../../clock/src";
import { createEventSystem } from "../../event-system/src";
import { createOrchestrator } from "../../orchestrator/src";
import { createLoader } from "../../loader/src";

import type { Agent, AgentDefinition } from "../../../contracts/agent";
import type { CommunicatorLibrary } from "../../../contracts/llm";
import { PATHS, agentPaths } from "../../../shared/config";
import { Events } from "../../../shared/actions";
import { consoleLogger, tagged, type Logger } from "../../../shared/logging";

/**
 * Build (but do not start) one Agent from its definition. The full per-Agent set
 * is constructed eagerly here; `start`/`stop` only sequence the already-wired
 * parts. Both are idempotent.
 */
export function createAgentInstance(
  def: AgentDefinition,
  deps?: {
    library?: CommunicatorLibrary;
    log?: Logger;
    publicPluginDir?: string;
    agentsDir?: string;
  },
): Agent {
  const log = tagged(deps?.log ?? consoleLogger, "[agent:" + def.id + "]");

  const publicPluginDir = path.resolve(process.cwd(), deps?.publicPluginDir ?? PATHS.publicPluginDir);
  const agentsDir = deps?.agentsDir ?? PATHS.agentsDir;
  const agentDir = path.resolve(process.cwd(), agentPaths(agentsDir, def.id).dir);

  // Empty-library fallback so a bare agent works with no LLM config.
  const library: CommunicatorLibrary =
    deps?.library ?? { get: () => undefined, has: () => false, list: () => [] };

  // The per-Agent independent set, constructed once.
  const clock = createClock({ defaultIntervalMs: def.intervalMs });
  const events = createEventSystem();
  const orchestrator = createOrchestrator({ events, clock, log });
  const loader = createLoader({
    agentId: def.id,
    def,
    events,
    orchestrator,
    library,
    publicPluginDir,
    agentDir,
    log,
  });

  // The ONLY wiring this node owns: turn each clock activation into a `clock.tick`
  // event on the bus. This is the sole place `clock.tick` is emitted.
  let tickSeq = 0;
  clock.onFire(() => {
    events.events.emit(Events.CLOCK_TICK, { at: Date.now(), data: { seq: ++tickSeq } });
  });

  let started = false;
  let stopped = false;

  const start = async (): Promise<void> => {
    if (started) return;
    started = true;
    events.events.emit(Events.AGENT_START, { at: Date.now(), data: { agentId: def.id } });
    await loader.load();
    orchestrator.start();
    clock.start();
  };

  const stop = async (): Promise<void> => {
    if (stopped || !started) return;
    stopped = true;
    clock.stop();
    orchestrator.stop();
    await loader.teardown();
  };

  return { id: def.id, start, stop };
}
