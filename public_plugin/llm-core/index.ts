/**
 * Plugin: llm-core — the LLM round-trip, and the per-Agent send LOCK.
 *
 * The orchestrator no longer composes on tick or guards the round-trip. Each frame it
 * emits a body-less TRIGGER (`llm.request` = Notify<{agentId}>). llm-core owns
 * serialization:
 *
 *   • It keeps at most ONE request in flight PER agentId (the trigger's `agentId` is
 *     the lock key). A trigger that arrives while that agent is busy does NOT start a
 *     concurrent request — it just flags `triggered`. When the in-flight request
 *     finishes, if `triggered` is set, llm-core composes a FRESH body and sends once
 *     more (coalescing a burst of triggers into a single follow-up), then goes idle.
 *   • Right before each send it pulls the body ON DEMAND via the orchestrator's
 *     `prompt.compose` action, so the request always reflects the latest blocks (a
 *     message that arrived while a previous request was in flight is folded into the
 *     next send). Tools come from the `tool-manager` plugin via `llm.list_tools`.
 *
 * It then picks a communicator from the key-less `ctx.llm` library, builds the chat
 * request from `{ context, messages }` (+ tools/temperature/maxTokens), emits
 * `llm.request.sent` (the exact assembled request, for observers), calls chat(), and
 * reports the normalized result as `llm.return`. On success it surfaces the
 * assistant's text as an `output.message` — the monologue HOOK observers watch;
 * channels do NOT render it (the agent reaches a channel only by calling that
 * channel's send tool).
 *
 * The core holds no LLM strategy — model choice is config (`communicator`), tools come
 * from other plugins, the prompt is whatever the orchestrator composed. The default
 * export is a PluginFactory — the loader calls it once per Agent, so ALL the mutable
 * state below lives in the factory closure, never in shared module scope (R6).
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type {
  ToolDef,
  Communicator,
  LLMRequest,
  LLMResponse,
  Message,
} from "../../contracts/llm";
import type { ComposedContext } from "../../contracts/context";
import {
  Actions,
  Events,
  type Request,
  type Reply,
  type Notify,
} from "../../shared/actions";
import { LLM_CORE_SCHEMA } from "./config-schema";

/**
 * Default provider error substrings/patterns that signal a context-overflow
 * REJECTION — matched case-insensitively (each tried as a regex, falling back to a
 * plain substring test). Drives the REACTIVE retry path: when a `chat()` rejects with
 * one of these, llm-core shrinks the prompt and retries instead of giving up.
 */
const DEFAULT_CONTEXT_ERROR_PATTERNS = [
  "context_length_exceeded",
  "maximum context length",
  "prompt is too long",
  "input is too long",
  "too many tokens",
  "reduce the length",
];

/** The config slice this plugin reads (everything optional). */
interface LLMCoreConfig {
  communicator?: string;
  temperature?: number;
  maxTokens?: number;
  /** Override the model's context-window size (tokens) used for the overflow budget. */
  contextLimitTokens?: number;
  /** Rough chars-per-token ratio for the prompt-size estimate (default 4). */
  charsPerToken?: number;
  /** Max prompt-shrink rounds per frame when overflowing the budget (default 3). */
  maxReduceRounds?: number;
  /** Tokens held back from the window as headroom when computing the budget (default 200). */
  safetyTokens?: number;
  /** Retry (after shrinking) when a chat() rejection looks like context overflow (default true). */
  retryOnContextError?: boolean;
  /** Provider-error patterns that mark a rejection as context overflow (default DEFAULT_CONTEXT_ERROR_PATTERNS). */
  contextErrorPatterns?: string[];
}

/** Safe view of `ctx.config` — only the keys of the right runtime type survive. */
function readConfig(raw: unknown): LLMCoreConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const out: LLMCoreConfig = {};
  if (typeof c.communicator === "string") out.communicator = c.communicator;
  if (typeof c.temperature === "number") out.temperature = c.temperature;
  if (typeof c.maxTokens === "number") out.maxTokens = c.maxTokens;
  if (typeof c.contextLimitTokens === "number" && c.contextLimitTokens > 0)
    out.contextLimitTokens = c.contextLimitTokens;
  if (typeof c.charsPerToken === "number" && c.charsPerToken > 0)
    out.charsPerToken = c.charsPerToken;
  if (typeof c.maxReduceRounds === "number" && c.maxReduceRounds >= 0)
    out.maxReduceRounds = c.maxReduceRounds;
  if (typeof c.safetyTokens === "number" && c.safetyTokens >= 0)
    out.safetyTokens = c.safetyTokens;
  if (typeof c.retryOnContextError === "boolean")
    out.retryOnContextError = c.retryOnContextError;
  if (Array.isArray(c.contextErrorPatterns)) {
    const patterns = c.contextErrorPatterns.filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    out.contextErrorPatterns = patterns;
  }
  return out;
}

/**
 * Does `err` look like a provider context-overflow rejection? Each pattern is tried
 * as a case-insensitive regex; an invalid regex falls back to a plain substring test.
 * Empty `patterns` ⇒ never a context error.
 */
function isContextError(err: unknown, patterns: string[]): boolean {
  const s = String(err);
  return patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(s);
    } catch {
      return s.toLowerCase().includes(p.toLowerCase());
    }
  });
}

/**
 * Rough token estimate of an about-to-be-sent body: the composed context text +
 * each message's text content (string content and `text` ContentParts; non-text
 * parts ignored) + the serialized tool definitions, divided by `charsPerToken`.
 */
function estimateTokens(
  context: ComposedContext,
  turns: Message[],
  toolDefs: ToolDef[],
  charsPerToken: number,
): number {
  let chars = context.text.length;
  for (const m of turns) {
    if (typeof m.content === "string") {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") chars += part.text.length;
      }
    }
  }
  if (toolDefs.length > 0) chars += JSON.stringify(toolDefs).length;
  return Math.ceil(chars / charsPerToken);
}

/** Per-agentId send lock: at most one in flight; a trigger while busy coalesces. */
interface FrameState {
  inFlight: boolean;
  triggered: boolean;
}

const createLLMCore: PluginFactory = (): Plugin => {
  // --- per-Agent state (factory closure = one instance per Agent) -----------
  const states = new Map<string, FrameState>(); // keyed by the trigger's agentId
  let seq = 0; // monotonic corrId for each real dispatch (sent ↔ return)
  let unsubRequest: Unsub | undefined;
  let ctx: PluginContext | undefined;
  let config: LLMCoreConfig = {};
  // Set once in teardown() and never reset (a torn-down instance is discarded). Guards the
  // top of sendOnce(): a round-trip that was already IN FLIGHT when teardown ran re-enters
  // sendOnce() after its network await, but teardown cleared `ctx` — so the guard bails
  // before any `ctx!` dereference (which would throw) and before the missing-compose warning
  // (which would be a teardown-race false positive, not a genuine signal).
  let stopping = false;

  function emitReturn(reply: Reply<LLMResponse>): void {
    if (!ctx) return; // a late round-trip that resolves after teardown emits nothing
    ctx.events.emit(Events.LLM_RETURN, reply);
  }

  /**
   * The tools to attach to a chat request — read live from the `tool-manager`
   * plugin via `llm.list_tools`. Best-effort: a missing/erroring registry just
   * yields no tools, never failing the frame.
   */
  async function listTools(): Promise<ToolDef[]> {
    if (!ctx!.actions.has("llm.list_tools")) return [];
    try {
      const r = await ctx!.actions.invoke("llm.list_tools");
      return Array.isArray(r) ? (r as ToolDef[]) : [];
    } catch {
      return [];
    }
  }

  /** Resolve the configured communicator (or the first chat-capable one). */
  function resolveCommunicator(): Communicator | undefined {
    return config.communicator
      ? ctx!.llm.get(config.communicator)
      : ctx!.llm.get(ctx!.llm.withCapability("chat")[0]);
  }

  /**
   * Outcome of one round-trip. A chat() REJECTION is reported as `{kind:"error"}`
   * WITHOUT emitting any `llm.return` — the caller owns the terminal reply so it can
   * retry on a context-overflow rejection. The missing/incapable-communicator case
   * already emitted its own terminal `llm.return{ok:false}` (nothing more to do).
   */
  type RoundResult =
    | { kind: "ok" }
    | { kind: "no-communicator" }
    | { kind: "error"; error: string };

  /** One full round-trip for an already-composed body, under corrId `id`. */
  async function roundTrip(
    id: string,
    context: ComposedContext,
    turns: Message[],
  ): Promise<RoundResult> {
    const communicator: Communicator | undefined = resolveCommunicator();

    if (!communicator || typeof communicator.chat !== "function") {
      const error = config.communicator
        ? `llm-core: communicator "${config.communicator}" is missing or cannot chat`
        : "llm-core: no chat-capable communicator is available";
      ctx!.log.warn(error);
      emitReturn({ id, at: Date.now(), ok: false, error });
      return { kind: "no-communicator" };
    }

    // With turns, the composed context becomes the `system`; without, fall back to the
    // single-user-message shape.
    const base =
      turns.length > 0
        ? { system: context.text, messages: turns }
        : { messages: [{ role: "user" as const, content: context.text }] };

    const toolDefs = await listTools();
    const chatReq: LLMRequest = {
      ...base,
      ...(toolDefs.length > 0 ? { tools: toolDefs } : {}),
      ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    };

    // Surface the EXACT request being dispatched so observers (the inspector) can show
    // what was actually sent — fire-and-forget, same corrId as this frame's llm.return.
    const sent: Request<{ request: LLMRequest }> = { id, at: Date.now(), data: { request: chatReq } };
    ctx!.events.emit(Events.LLM_REQUEST_SENT, sent);

    try {
      const response = await communicator.chat(chatReq);
      emitReturn({ id, at: Date.now(), ok: true, data: response });
      if (ctx && typeof response.content === "string" && response.content.length > 0) {
        const msg: Notify<{ text: string; channel?: string }> = {
          at: Date.now(),
          data: { text: response.content, channel: undefined },
        };
        ctx.events.emit(Events.OUTPUT_MESSAGE, msg);
      }
      return { kind: "ok" };
    } catch (err) {
      // Emit NOTHING — the caller (sendOnce) decides whether to retry (context
      // overflow) or surface a terminal `llm.return{ok:false}`.
      return { kind: "error", error: String(err) };
    }
  }

  /** Compose ON DEMAND, then run one round-trip. No-op (logged) if nothing to compose. */
  async function sendOnce(): Promise<void> {
    // Teardown-race guard, FIRST — before any `ctx!` dereference. When teardown() ran while
    // a round-trip was in flight it set `stopping` AND cleared `ctx`; runLoop then re-enters
    // here after the network await. Bail silently: reaching `ctx!.actions` would throw, and
    // the missing-compose warning below would be a teardown-race false positive, not a signal.
    if (stopping) return;
    if (!ctx!.actions.has(Actions.PROMPT_COMPOSE)) {
      ctx!.log.warn("llm-core: prompt.compose is unavailable — cannot compose this frame");
      return;
    }

    // Resolve the communicator up front (same lookup roundTrip uses) so we can read its
    // declared context length for the overflow budget.
    const communicator = resolveCommunicator();

    // The budget is the model's context window minus reserved output tokens minus a
    // safety margin. `contextLength <= 0` (or absent) is inert → no budget, no loop.
    const cl = config.contextLimitTokens ?? communicator?.contextLength;
    const budget =
      typeof cl === "number" && cl > 0
        ? cl - (config.maxTokens ?? 0) - (config.safetyTokens ?? 200)
        : undefined;

    const compose = async (): Promise<{ context: ComposedContext; turns: Message[] } | undefined> => {
      let composed: { context?: ComposedContext; messages?: Message[] };
      try {
        composed = (await ctx!.actions.invoke(Actions.PROMPT_COMPOSE)) as {
          context?: ComposedContext;
          messages?: Message[];
        };
      } catch (err) {
        ctx!.log.warn("llm-core: prompt.compose failed: " + String(err));
        return undefined;
      }
      const context = composed?.context;
      if (!context || typeof context.text !== "string") {
        ctx!.log.warn("llm-core: prompt.compose returned no usable context");
        return undefined;
      }
      const turns: Message[] = Array.isArray(composed.messages) ? composed.messages : [];
      return { context, turns };
    };

    const initial = await compose();
    if (!initial) return;
    let { context, turns } = initial;

    const charsPerToken = config.charsPerToken ?? 4;
    const maxReduceRounds = config.maxReduceRounds ?? 3;
    const retryOnCtx = config.retryOnContextError ?? true;
    const patterns = config.contextErrorPatterns ?? DEFAULT_CONTEXT_ERROR_PATTERNS;

    // Tool defs are stable this frame — fetch ONCE, only when a budget makes the
    // estimate meaningful (both the proactive loop and the reactive estimate reuse it).
    const toolDefs: ToolDef[] = budget !== undefined ? await listTools() : [];

    // A SINGLE shared round counter across BOTH the proactive (char-estimate) settle
    // loop below and the reactive (provider-rejection) retry loop further down, so
    // reactive rounds CONTINUE from any proactive rounds — `round` escalates monotonically
    // and is the hard cap on total prompt-shrink rounds this frame.
    let round = 0;

    // PROACTIVE settle loop. SKIPPED entirely when there's no budget or shrinking is
    // disabled — no event, single compose. On exit `round` = number of `context.full`
    // emissions made here.
    if (budget !== undefined && maxReduceRounds !== 0) {
      if (!ctx) return; // torn down while listing tools — emit nothing
      let lastEstimate: number | undefined;
      while (round < maxReduceRounds) {
        const est = estimateTokens(context, turns, toolDefs, charsPerToken);
        if (est <= budget) break; // fits — STRICT overflow is est > budget
        if (est === lastEstimate) break; // no progress — reactors can't shrink further
        lastEstimate = est;
        round += 1;
        const notify: Notify<{ estimatedTokens: number; limit: number; overBy: number; round: number }> = {
          at: Date.now(),
          data: { estimatedTokens: est, limit: budget, overBy: est - budget, round },
        };
        ctx!.events.emit(Events.CONTEXT_FULL, notify);
        const next = await compose();
        if (!next) return;
        ({ context, turns } = next);
      }
      const finalEst = estimateTokens(context, turns, toolDefs, charsPerToken);
      if (finalEst > budget) {
        ctx!.log.warn(
          `llm-core: prompt still over budget after ${maxReduceRounds} shrink round(s) ` +
            `(~${finalEst} > ${budget} tokens) — sending best-effort`,
        );
      }
    }

    // REACTIVE retry loop: send, and if the provider REJECTS with a context-overflow
    // error, shrink (emit `context.full`, re-compose) and try again — sharing `round`
    // with the proactive loop so the two together never exceed `maxReduceRounds`. Each
    // attempt uses a FRESH corrId; the terminal `llm.return` is owned here.
    for (;;) {
      if (!ctx) return; // torn down while composing — emit nothing
      const id = String(++seq);
      const result = await roundTrip(id, context, turns);
      if (result.kind === "ok" || result.kind === "no-communicator") return;
      // result.kind === "error": a chat() rejection that roundTrip did NOT report.
      if (retryOnCtx && round < maxReduceRounds && isContextError(result.error, patterns)) {
        round += 1;
        if (!ctx) return; // torn down — emit nothing
        const est =
          budget !== undefined ? estimateTokens(context, turns, toolDefs, charsPerToken) : 0;
        const notify: Notify<{ estimatedTokens: number; limit: number; overBy: number; round: number }> = {
          at: Date.now(),
          data: {
            estimatedTokens: est,
            limit: budget ?? 0,
            overBy: budget !== undefined ? Math.max(0, est - budget) : 0,
            round,
          },
        };
        ctx!.events.emit(Events.CONTEXT_FULL, notify);
        const next = await compose();
        if (!next) {
          // Re-compose failed — surface the provider error under this attempt's corrId.
          emitReturn({ id, at: Date.now(), ok: false, error: result.error });
          return;
        }
        ({ context, turns } = next);
        continue;
      }
      // Non-context error, retry disabled, or the shared round cap is reached —
      // terminal failure under the LAST attempt's corrId.
      emitReturn({ id, at: Date.now(), ok: false, error: result.error });
      return;
    }
  }

  /**
   * The send loop for ONE agentId. Sends once for the trigger that started it, then —
   * while triggers kept arriving during a send — sends one more re-composed follow-up,
   * coalescing a burst into a single extra round-trip. Always clears `inFlight` at the
   * end (even on an error), so the lock can never wedge.
   */
  async function runLoop(st: FrameState): Promise<void> {
    try {
      do {
        st.triggered = false;
        await sendOnce();
      } while (st.triggered);
    } finally {
      st.inFlight = false;
    }
  }

  return {
    manifest: {
      id: "llm-core",
      version: "0.1.0",
      // The tool REGISTRY moved to the `tool-manager` plugin; we read it at send
      // time via `llm.list_tools`, so we require that action to be on the bus.
      requires: ["llm.list_tools"],
      configSchema: LLM_CORE_SCHEMA,
    },

    setup(pluginCtx: PluginContext) {
      ctx = pluginCtx;
      config = readConfig(pluginCtx.config);

      // --- the per-agentId send lock -----------------------------------
      // A trigger (`llm.request` = Notify<{agentId}>) asks for a round-trip. While an
      // agent is in flight, a trigger only flags `triggered`; otherwise it starts the
      // send loop. The agentId is the lock key (falls back to this Agent's own id).
      unsubRequest = pluginCtx.events.on(Events.LLM_REQUEST, (payload: unknown) => {
        if (payload === null || typeof payload !== "object") return;
        const data = (payload as Notify<{ agentId?: unknown }>).data;
        const key =
          typeof data?.agentId === "string" && data.agentId.length > 0
            ? data.agentId
            : pluginCtx.agentId;
        let st = states.get(key);
        if (!st) {
          st = { inFlight: false, triggered: false };
          states.set(key, st);
        }
        if (st.inFlight) {
          st.triggered = true; // coalesce — do NOT start a concurrent request
          return;
        }
        st.inFlight = true;
        void runLoop(st);
      });
    },

    teardown() {
      stopping = true;
      unsubRequest?.();
      unsubRequest = undefined;
      ctx = undefined;
      config = {};
      states.clear();
    },
  };
};

export default createLLMCore;
