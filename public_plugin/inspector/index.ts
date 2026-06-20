/**
 * inspector — a READ-ONLY browser debug/analysis dashboard plugin.
 *
 * A passive sibling of the `web` plugin. It SUBSCRIBES to every bus event and
 * exposes the captured stream over a loopback HTTP server (one per process,
 * refcounted across all per-Agent instances) with per-agent SSE and a bounded
 * per-agent in-memory record ring.
 *
 * It EMITS NOTHING on the bus — only `ctx.events.on(...)` (subscribe) and
 * `ctx.print(...)`. It never calls `ctx.events.emit` or `ctx.actions`.
 *
 * Isolation (R6): an agent's records are only ever served from its own AgentReg;
 * agent A never sees agent B's data. All mutable state lives in the factory
 * closure or the module-level hub — the factory itself is side-effect free.
 *
 * This file is just the factory: it resolves config (config.ts), joins the
 * process-wide hub (hub.ts), and maps each captured bus event into an
 * EventRecord that it hands to the hub's per-agent ring. Storage, the HTTP
 * router, and the served page live in their own sibling files.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import { Events } from "../../shared/actions";
import { resolveConfig } from "./config";
import { INSPECTOR_SCHEMA } from "./config-schema";
import {
  hubRegister,
  hubDeregister,
  pushRecord,
  safeStringify,
  type AgentReg,
  type EventRecord,
} from "./hub";

// ---- the plugin factory ------------------------------------------------------

const manifest = { id: "inspector", version: "0.1.0", configSchema: INSPECTOR_SCHEMA };

/** Map each captured event name onto its dashboard `kind`. */
const KIND: { [eventName: string]: string } = {
  [Events.AGENT_START]: "agent.start",
  [Events.CLOCK_TICK]: "tick",
  [Events.PROMPT_GATHER]: "gather",
  [Events.LLM_REQUEST]: "prompt.sent",
  [Events.LLM_REQUEST_SENT]: "prompt.sent",
  [Events.LLM_RETURN]: "prompt.received",
  [Events.INPUT_MESSAGE]: "input",
  [Events.OUTPUT_MESSAGE]: "output",
  [Events.TOOL_RESULT]: "tool.result",
  [Events.LOG]: "log",
};

const factory: PluginFactory = (): Plugin => {
  // Per-Agent (factory closure) state.
  let unsubs: Unsub[] = [];
  let seq = 0;
  let reg: AgentReg | null = null;
  let agentId = "";

  async function setup(ctx: PluginContext): Promise<void> {
    agentId = ctx.agentId;

    // ---- config resolution (merge nested-over-flat + validation) ----
    const cfg = resolveConfig(ctx);

    // ---- join the refcounted hub (first registration listens) ----
    const joined = await hubRegister(agentId, { port: cfg.port, host: cfg.host, token: cfg.token });
    reg = joined.reg;
    const boundPort = joined.boundPort;
    // The process token is whatever the first agent set; use it in our URL.
    const procToken = joined.token;

    // Past this point we hold a hub reference; if anything throws before setup()
    // returns (e.g. ctx.print), undo the registration so we don't orphan the ref.
    try {
    // ---- capture: subscribe to every bus event ----
    const capture = (eventName: string, kind: string): void => {
      const unsub = ctx.events.on(eventName, (payload: unknown) => {
        // Handlers must NEVER throw — that would break bus fan-out. Record
        // best-effort and swallow everything.
        try {
          let corrId: string | undefined;
          if (payload && typeof payload === "object") {
            const id = (payload as { id?: unknown }).id;
            if (typeof id === "string") corrId = id;
          }

          // corrId was already extracted from the ORIGINAL payload above, so
          // truncation here never loses correlation. Emit a STRUCTURED marker
          // (not a string) so consumers can detect truncation explicitly.
          let recPayload: unknown = payload;
          const json = safeStringify(payload);
          if (json.length > cfg.maxRecordBytes) {
            recPayload = { __truncated: true, bytes: json.length, preview: json.slice(0, cfg.maxRecordBytes) };
          }

          const rec: EventRecord = {
            seq: seq++,
            at: Date.now(),
            kind,
            agentId,
            corrId,
            payload: recPayload,
          };

          // Hand off to the hub: FIFO ring append + SSE fan-out (R6).
          if (reg) pushRecord(reg, rec, cfg.bufferSize);
        } catch {
          /* best-effort: never throw out of a bus handler */
        }
      });
      unsubs.push(unsub);
    };

    for (const eventName of Object.keys(KIND)) {
      capture(eventName, KIND[eventName]);
    }

    // ---- starting message: MUST land during setup() (before it returns) ----
    // Print exactly ONCE — only the agent that actually created the server. A
    // 0.0.0.0/:: bind isn't dialable, so advertise loopback in the URL instead;
    // boundPort === 0 means the listen failed (almost always a busy port).
    if (joined.created) {
      if (boundPort > 0) {
        const displayHost = (cfg.host === "0.0.0.0" || cfg.host === "::") ? "127.0.0.1" : cfg.host;
        ctx.print("✦ Inspector: http://" + displayHost + ":" + boundPort + "/?token=" + procToken);
      } else {
        ctx.print("✖ Inspector: could not bind " + cfg.host + ":" + cfg.port +
          " — is the port already in use? Set config.inspector.port to a free port.");
      }
    }
    } catch (e) {
      hubDeregister(agentId);
      throw e;
    }
  }

  function teardown(): void {
    // Unwind every subscription.
    for (const u of unsubs) {
      try {
        u();
      } catch {
        /* ignore */
      }
    }
    unsubs = [];
    // Drop us from the hub; hubDeregister owns SSE-client teardown (it ends every
    // client) and closes the server once the last agent leaves.
    if (agentId) hubDeregister(agentId);
    reg = null;
  }

  return { manifest, setup, teardown };
};

export default factory;
