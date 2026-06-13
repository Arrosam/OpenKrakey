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
import type { EventBus } from "../../../contracts/event-system";
import { PATHS, agentPaths } from "../../../shared/config";
import { Events } from "../../../shared/actions";
import { consoleLogger, tagged, type Logger } from "../../../shared/logging";

/**
 * Bridge a CORE-INTERNAL logger onto this Agent's eventbus: every line still goes
 * to `base` (console unchanged) AND is mirrored as a `log.entry` event tagged with
 * a `core:<module>` source, so a debug/observer plugin can see core diagnostics.
 * The mirror is best-effort — it must never throw into the core logger call.
 */
function busLogger(base: Logger, bus: EventBus, source: string): Logger {
  const mirror = (level: "info" | "warn" | "error", text: string) => {
    try {
      bus.emit(Events.LOG, { at: Date.now(), data: { level, pluginId: source, text } });
    } catch {
      /* a logging mirror must never break the caller */
    }
  };
  return {
    info: (m) => { base.info(m); mirror("info", m); },
    warn: (m) => { base.warn(m); mirror("warn", m); },
    error: (m) => { base.error(m); mirror("error", m); },
  };
}

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
    /** Sink for plugin ctx.print lines (forwarded to the loader). */
    print?: (text: string) => void;
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
    deps?.library ??
    { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] };

  // The per-Agent independent set, constructed once.
  const clock = createClock({ defaultIntervalMs: def.intervalMs });
  const events = createEventSystem();
  // Bridge ONLY the orchestrator's diagnostic logger onto this Agent's eventbus as
  // `log.entry` (tagged `core:orchestrator`), keeping `log` as the base so console
  // output is unchanged. The loader is NOT bridged here: it reuses its logger to
  // echo every plugin's ctx.log.* line, so mirroring it would duplicate plugin
  // logs on the bus — the loader self-reports its own diagnostics (tagged
  // `core:loader`) directly. So the loader gets the plain agent-tagged console
  // logger `log`.
  const orchLog = busLogger(log, events.events, "core:orchestrator");
  const orchestrator = createOrchestrator({ events, clock, log: orchLog });
  const loader = createLoader({
    agentId: def.id,
    def,
    events,
    orchestrator,
    library,
    publicPluginDir,
    agentDir,
    log,
    print: deps?.print,
  });

  // The ONLY wiring this node owns: turn each clock activation into a `clock.tick`
  // event on the bus. This is the sole place `clock.tick` is emitted.
  let tickSeq = 0;
  clock.onFire(() => {
    events.events.emit(Events.CLOCK_TICK, { at: Date.now(), data: { seq: ++tickSeq } });
  });

  let started = false;
  let stopped = false;
  let running = false;

  const start = async (): Promise<void> => {
    if (started) return;
    started = true;
    await loader.load();
    // A stop() may have arrived while load was in flight: nothing is wired yet,
    // so tear the just-loaded plugins down and end genuinely stopped — no
    // AGENT_START, no armed timer.
    if (stopped) {
      await loader.teardown();
      return;
    }
    // Emit after plugins have subscribed (during load) but before the first tick.
    events.events.emit(Events.AGENT_START, { at: Date.now(), data: { agentId: def.id } });
    orchestrator.start();
    clock.start();
    running = true;
  };

  const stop = async (): Promise<void> => {
    if (stopped || !started) return;
    stopped = true;
    if (!running) return; // start() is mid-load — it owns teardown of the in-flight load.
    clock.stop();
    orchestrator.stop();
    await loader.teardown();
  };

  return { id: def.id, start, stop };
}
