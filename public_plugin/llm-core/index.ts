/**
 * Plugin: llm-core — the LLM round-trip, and nothing else.
 *
 * It is the only thing that answers the orchestrator's `llm.request`: it picks a
 * communicator from the key-less `ctx.llm` library, sends the composed context as a
 * single user message (with any registered tools), and reports the normalized result
 * back as `llm.return`. On success it also surfaces the assistant's text as an
 * `output.message` so channels can show it.
 *
 * It doubles as the tool-registration hub via the `llm.register_tool` action: tool
 * plugins declare the L1 `ToolDef`s that ride along on every chat request. The core
 * holds no LLM strategy — model choice is config (`communicator`), tools come from
 * other plugins, and the prompt is whatever context the orchestrator composed.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent, so
 * ALL the mutable state below (the tool Map, the Unsubs, the captured context and
 * config) lives in the factory closure, never in shared module scope.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type {
  ToolDef,
  Communicator,
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
  type ConversationMessage,
} from "../../shared/actions";

/** The config slice this plugin reads (everything optional). */
interface LLMCoreConfig {
  communicator?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Safe view of `ctx.config` — only the keys of the right runtime type survive. */
function readConfig(raw: unknown): LLMCoreConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  const out: LLMCoreConfig = {};
  if (typeof c.communicator === "string") out.communicator = c.communicator;
  if (typeof c.temperature === "number") out.temperature = c.temperature;
  if (typeof c.maxTokens === "number") out.maxTokens = c.maxTokens;
  return out;
}

const createLLMCore: PluginFactory = (): Plugin => {
  // --- per-Agent state (factory closure = one instance per Agent) -----------

  /** ToolDefs declared by tool plugins, keyed by name (re-register replaces). */
  const tools = new Map<string, ToolDef>();
  let unsubRequest: Unsub | undefined;
  let unregisterTool: Unsub | undefined;
  let ctx: PluginContext | undefined;
  let config: LLMCoreConfig = {};

  function emitReturn(reply: Reply<LLMResponse>): void {
    ctx!.events.emit(Events.LLM_RETURN, reply);
  }

  async function answer(
    req: Request<{ context: ComposedContext }>,
    context: ComposedContext,
  ): Promise<void> {
    const { id } = req;

    const communicator: Communicator | undefined = config.communicator
      ? ctx!.llm.get(config.communicator)
      : ctx!.llm.get(ctx!.llm.withCapability("chat")[0]);

    if (!communicator || typeof communicator.chat !== "function") {
      const error = config.communicator
        ? `llm-core: communicator "${config.communicator}" is missing or cannot chat`
        : "llm-core: no chat-capable communicator is available";
      ctx!.log.warn(error);
      emitReturn({ id, at: Date.now(), ok: false, error });
      return;
    }

    // Pull the conversation (Hermes turns) from whoever provides it; absent → [].
    let conversation: ConversationMessage[] = [];
    try {
      const got = await ctx!.actions.invoke(Actions.CONVERSATION_GET);
      if (Array.isArray(got)) conversation = got as ConversationMessage[];
    } catch {
      // No conversation provider (e.g. no history plugin) — fall back below.
    }
    // Strip provenance (at/source) to the wire Message[]; a user turn's source is
    // already surfaced via Message.name. With a conversation, the composed context
    // becomes the `system`; without one, fall back to the single-user-message shape.
    const turns: Message[] = conversation.map(({ at, source, ...m }) => m);
    const base =
      turns.length > 0
        ? { system: context.text, messages: turns }
        : { messages: [{ role: "user" as const, content: context.text }] };

    const chatReq = {
      ...base,
      ...(tools.size > 0 ? { tools: [...tools.values()] } : {}),
      ...(config.temperature !== undefined
        ? { temperature: config.temperature }
        : {}),
      ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
    };

    try {
      const response = await communicator.chat(chatReq);
      emitReturn({ id, at: Date.now(), ok: true, data: response });
      if (typeof response.content === "string" && response.content.length > 0) {
        const msg: Notify<{ text: string; channel?: string }> = {
          at: Date.now(),
          data: { text: response.content, channel: undefined },
        };
        ctx!.events.emit(Events.OUTPUT_MESSAGE, msg);
      }
    } catch (err) {
      emitReturn({ id, at: Date.now(), ok: false, error: String(err) });
    }
  }

  return {
    manifest: {
      id: "llm-core",
      version: "0.1.0",
      provides: ["llm.register_tool"],
    },

    setup(pluginCtx: PluginContext) {
      ctx = pluginCtx;
      config = readConfig(pluginCtx.config);

      // --- tool registration hub ---------------------------------------
      unregisterTool = pluginCtx.actions.register(
        "llm.register_tool",
        async (params: unknown) => {
          if (
            params === null ||
            typeof params !== "object" ||
            typeof (params as ToolDef).name !== "string" ||
            (params as ToolDef).name.length === 0
          ) {
            throw new Error(
              "llm.register_tool: params must be a ToolDef with a non-empty string `name`",
            );
          }
          const def = params as ToolDef;
          tools.set(def.name, def);
          return true;
        },
      );

      // --- the LLM round-trip ------------------------------------------
      unsubRequest = pluginCtx.events.on(Events.LLM_REQUEST, (payload: unknown) => {
        // Ignore malformed requests silently — never throw out of a listener.
        if (payload === null || typeof payload !== "object") return;
        const req = payload as Request<{ context: ComposedContext }>;
        const context = req.data?.context;
        if (context === null || typeof context !== "object") return;
        if (typeof context.text !== "string") return;

        // Settle each request independently in its own async task.
        void answer(req, context);
      });
    },

    teardown() {
      unsubRequest?.();
      unregisterTool?.();
      unsubRequest = undefined;
      unregisterTool = undefined;
      ctx = undefined;
      config = {};
      tools.clear();
    },
  };
};

export default createLLMCore;
