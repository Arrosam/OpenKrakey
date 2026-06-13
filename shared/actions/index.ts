/**
 * Shared: actions — the canonical bus vocabulary: well-known names + payload SHAPES.
 *
 * Division of labour (see ARCHITECTURE §3):
 *  - EventBus carries the small set of GENERIC lifecycle events below — the core
 *    emits them to ACTIVATE plugins (startup, gather prompt blocks, LLM request/
 *    return, channel I/O). Each payload specializes one of the reusable base
 *    envelopes (Notify / Request / Reply).
 *  - ActionBus carries plugin-registered, invokable operations (tool calls,
 *    channel ops) and inter-plugin calls. Those names are plugin-specific and are
 *    registered at setup, so they are NOT enumerated here.
 */
import type { ComposedContext } from "../../contracts/context";
import type { LLMResponse } from "../../contracts/llm";

/**
 * Well-known actions invoked on the actionbus. (LLM access is NOT an action —
 * plugins use the key-less `PluginContext.llm` library directly.)
 *
 * CLOCK_* rhythm controls are registered by the orchestrator while it is started
 * (unregistered on stop). Params: the two setters take `{ ms: number }` (positive);
 * `clock.fire_now` takes none.
 */
export const Actions = {
  CLOCK_SET_INTERVAL: "clock.set_interval",
  CLOCK_SET_DEFAULT_INTERVAL: "clock.set_default_interval",
  CLOCK_FIRE_NOW: "clock.fire_now",
} as const;

/** Well-known generic events emitted on the eventbus to activate plugins. */
export const Events = {
  AGENT_START: "agent.start",
  CLOCK_TICK: "clock.tick",
  PROMPT_GATHER: "prompt.gather",
  LLM_REQUEST: "llm.request",
  LLM_RETURN: "llm.return",
  INPUT_MESSAGE: "input.message",
  OUTPUT_MESSAGE: "output.message",
  TOOL_RESULT: "tool.result",
  LOG: "log.entry",
} as const;

export type ActionName = (typeof Actions)[keyof typeof Actions];
export type EventName = (typeof Events)[keyof typeof Events];

// ---- Reusable base event envelopes ----
/** One-way notification (fire-and-forget). */
export interface Notify<T = unknown> {
  at: number;
  data: T;
}
/** Expects a matching Reply with the same `id`. */
export interface Request<T = unknown> {
  id: string;
  at: number;
  data: T;
}
/** The reply to a Request (same `id`). */
export interface Reply<T = unknown> {
  id: string;
  at: number;
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Concrete well-known event payloads. Each specializes a base envelope. Keys are
 * the `Events` string values (kept literal so this compiles as an interface).
 */
export interface EventPayloads {
  "agent.start": Notify<{ agentId: string }>;
  "clock.tick": Notify<{ seq: number }>;
  "prompt.gather": Notify<{ seq: number }>;
  "llm.request": Request<{ context: ComposedContext }>;
  "llm.return": Reply<LLMResponse>;
  "input.message": Notify<{ text: string; from?: string; channel?: string; meta?: Record<string, unknown> }>;
  "output.message": Notify<{ text: string; to?: string; channel?: string; meta?: Record<string, unknown> }>;
  /** Emitted by the orchestrator as each dispatched tool call settles (id = ToolCall id). */
  "tool.result": Reply<unknown> & { name: string };
  /**
   * A plugin console line mirrored onto the bus by the loader-built ctx:
   * ctx.log.* carries its level; ctx.print carries level "print" (the plugin's
   * clean user-facing line — during setup, its starting message).
   */
  "log.entry": Notify<{ level: "info" | "warn" | "error" | "print"; pluginId: string; text: string }>;
}

// Compile-time guard: every Events value has a payload entry and vice-versa.
type _EventsMatchPayloads = EventName extends keyof EventPayloads
  ? keyof EventPayloads extends EventName
    ? true
    : never
  : never;
const _eventsMatchPayloads: _EventsMatchPayloads = true;
void _eventsMatchPayloads;
