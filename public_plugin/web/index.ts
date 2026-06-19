/**
 * Plugin: web — the browser chat channel.
 *
 * A sibling of any other channel behind the same INPUT event seam: a typed browser
 * message becomes `input.message` (and wakes the beat via `clock.fire_now`). OUTPUT is
 * explicit — the agent speaks to this channel ONLY by calling the `web.send_message`
 * tool; the orchestrator dispatches that tool call to this plugin's action, which
 * persists the text and streams it to the browser over SSE. The LLM's raw return
 * (`output.message`) is a private monologue this channel does NOT render. Per message
 * it reports a delivery status — `sent` when the message is appended to the event
 * queue, `read` once the agent's beat has processed it (signalled by `llm.return`).
 *
 * process resource ownership (one process owns one terminal, one port): one
 * `node:http` server per process, owned by a MODULE-LEVEL hub (./hub) shared +
 * refcounted by every per-Agent instance — the only legitimate process-singleton
 * owner. Per-Agent mutable state still lives in each factory closure (R6); the hub
 * holds only an opaque per-agent registry { agentId, deliver, sse-clients, store,
 * pending, inFlight } so no Agent can observe another's input or output.
 *
 * Security: the server binds LOOPBACK by default (config.web.host, default
 * 127.0.0.1 — not all interfaces, so it is not LAN-reachable) and every /api/*
 * route requires a per-process SESSION TOKEN (random, or config.web.token). The
 * token is printed once with the URL — only the console that ran the program sees
 * it, so a random local process never learns it. GET / serves the page (no
 * secrets) and, when opened with the valid ?token=, sets an HttpOnly cookie so the
 * page's same-origin fetch/SSE authenticate automatically (no token in API URLs).
 *
 * Context: web contributes a `web.guidance` system block (what this channel is and
 * that the agent reaches its user only via web.send_message) plus the `web.conversation`
 * message block (web's own chat history rendered as clean turns).
 *
 * The default export is a PluginFactory — the loader calls it once per Agent; only
 * the hub (a process resource) is module-level. Persistence + the transcript live
 * in ./transcript-store; the HTTP/SSE server + auth live in ./hub.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { LLMResponse, Message, ToolDef } from "../../contracts/llm";
import { Actions, Events, type EventPayloads, type Reply } from "../../shared/actions";
import {
  type AgentReg,
  addReg,
  removeReg,
  broadcast,
  ensureServer,
  maybeStopServer,
  seedMsgSeq,
} from "./hub";
import { TranscriptStore } from "./transcript-store";
import { windowTranscript } from "./windowing";

const DEFAULT_PORT = 7717;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_TURNS = 60;
const DEFAULT_MAX_CHARS = 24000;

/** The chat-tool action the orchestrator dispatches when the LLM decides to speak. */
const SEND_MESSAGE_ACTION = "web.send_message";

/**
 * web's CONVERSATION context block — web maintains its OWN chat history (the per-agent
 * transcript it already persists for the browser) and contributes it to the prompt as
 * the conversation. Each stored turn renders as a CLEAN wire message: a user message →
 * {role:"user", name:"web"}, an agent send (web.send_message) → {role:"assistant"}. The
 * LLM's plain monologue is never stored (web records only what the user said and what the
 * agent explicitly sent), so the prompt's conversation stays clean — no monologue, no
 * tool-call mechanics.
 *
 * Priority 5000 (median): below the stable system blocks (persona 10000, system-prompt
 * 9000), leaving room for other message-blocks to inject before (>5000) or after (<5000).
 */
const CONVERSATION_BLOCK_ID = "web.conversation";
const CONVERSATION_PRIORITY = 5000;

/**
 * web's GUIDANCE context block — a SYSTEM-target block teaching the LLM what THIS
 * channel is and how to use it: Web Chat is a message channel, and the agent reaches
 * its user ONLY by calling the web.send_message tool. Channel-SPECIFIC by design — the
 * GENERAL operating model (the private-monologue rule, "act only via tools") lives in
 * the separate `system-prompt` plugin; this block does not restate it.
 *
 * Priority 8000: a stable system block that sits below persona (10000, identity) and
 * system-prompt (9000, general model), so the system prompt reads identity → general
 * model → this channel's specifics. Text + priority overridable via config.
 */
const GUIDANCE_BLOCK_ID = "web.guidance";
const GUIDANCE_PRIORITY = 8000;
const DEFAULT_GUIDANCE =
  "You are connected to a human through Web Chat, a message channel. In the " +
  "conversation, messages tagged `web` are what this user typed to you. To say " +
  "anything back to them — an answer, a question, an acknowledgement — you must call " +
  "the `web.send_message` tool; this channel delivers ONLY what you send through that " +
  "tool. Merely thinking a reply does not send it.";

/**
 * A configured token is adopted only if it's a URL/cookie-safe string of length
 * ≥ 16; anything else is rejected in favour of a fresh random token (parity with
 * inspector/config.ts). Keeps a too-short or malformed pinned token from becoming
 * a weak, guessable process secret.
 */
function validToken(t: unknown): t is string {
  return typeof t === "string" && t.length >= 16 && /^[A-Za-z0-9._~+\/=-]+$/.test(t);
}

const createWeb: PluginFactory = (): Plugin => {
  let reg: AgentReg | undefined;
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "web", version: "0.1.0", requires: ["llm.register_tool"] },

    async setup(ctx: PluginContext): Promise<void> {
      // Destructure the only ctx members the long-lived closures need, so the rest
      // of ctx (config, dataDir, print, …) can be GC'd once setup() returns instead
      // of being pinned for the agent's lifetime by the closures stored in `regs`.
      // removeBlock is one such member — the teardown thunks in `unsubs` call it to
      // drop web's context blocks (the guidance + conversation blocks), so we capture
      // just it rather than retaining ctx.
      const { events, actions, removeBlock } = ctx;

      const cfg = (ctx.config ?? {}) as {
        port?: number;
        host?: string;
        token?: string;
        guidance?: string;
        guidancePriority?: number;
        conversationMaxTurns?: number;
        conversationMaxChars?: number;
      };
      const port = typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;
      const host = typeof cfg.host === "string" && cfg.host ? cfg.host : DEFAULT_HOST;
      // A fresh random token per process unless a VALID one is pinned in config.
      // Accept the configured token only if it's a URL/cookie-safe string of length
      // ≥ 16; otherwise fall back to a random token (parity with inspector — an
      // invalid configured token is NOT adopted, so a request presenting it gets 401).
      const tk = validToken(cfg.token)
        ? (cfg.token as string)
        : crypto.randomBytes(24).toString("base64url");

      // Conversation windowing bounds: how many trailing transcript entries and how
      // many cumulative characters web's conversation block may render into the prompt.
      // Each is config-overridable but only when a positive number; otherwise default.
      const maxTurns =
        typeof cfg.conversationMaxTurns === "number" && cfg.conversationMaxTurns > 0
          ? cfg.conversationMaxTurns
          : DEFAULT_MAX_TURNS;
      const maxChars =
        typeof cfg.conversationMaxChars === "number" && cfg.conversationMaxChars > 0
          ? cfg.conversationMaxChars
          : DEFAULT_MAX_CHARS;

      // Ensure the per-plugin (agent-isolated) data dir exists, then load any prior
      // transcript so history survives a restart. Best-effort: a dir/read failure
      // just starts the agent with an empty transcript.
      const chatPath = path.join(ctx.dataDir, "chat.jsonl");
      try {
        fs.mkdirSync(ctx.dataDir, { recursive: true });
      } catch {
        /* best-effort: an unwritable dataDir degrades to in-memory only */
      }

      const store = await TranscriptStore.load(chatPath);
      // Seed the module-global id counter past every persisted id so a new message
      // can never reuse an id that survived a restart (M-8 collision).
      seedMsgSeq(store.maxId());

      const r: AgentReg = {
        agentId: ctx.agentId,
        store,
        deliver: (text, msgId) => {
          const payload: EventPayloads["input.message"] = {
            at: Date.now(),
            data: { text, channel: "web", meta: { msgId } },
          };
          events.emit(Events.INPUT_MESSAGE, payload);
          if (actions.has(Actions.CLOCK_FIRE_NOW)) {
            actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
          }
        },
        clients: new Set(),
        pending: [],
        inFlight: new Map(),
        greeting: "agent '" + ctx.agentId + "' is awake — type to talk.",
      };
      reg = r;
      addReg(r);

      // Stream an agent message to THIS agent's browser clients (persist + broadcast).
      // Named distinctly from r.deliver (the opposite-direction INPUT path: emit
      // input.message + wake the beat) so the two can't be confused in a later edit.
      const streamAgentMessage = (text: string): void => {
        r.store.append({ role: "agent", text, at: Date.now() });
        broadcast(r, { type: "output", text });
      };

      // The agent speaks to THIS channel only by explicitly calling web.send_message;
      // the orchestrator dispatches that tool call to this action. (The LLM's plain
      // return — output.message — is a private monologue web no longer renders.)
      const offSend = actions.register(SEND_MESSAGE_ACTION, async (params: unknown) => {
        const text =
          params && typeof params === "object"
            ? (params as { text?: unknown }).text
            : undefined;
        if (typeof text !== "string" || text.length === 0) {
          throw new Error("web.send_message: params must be { text: non-empty string }");
        }
        streamAgentMessage(text);
        return { delivered: true };
      });

      // Declare the chat tool so the LLM can call it. Since web.send_message is now web's
      // ONLY path to the browser, the manifest `requires: ["llm.register_tool"]` makes the
      // loader fail the agent LOUDLY if the tool registry (llm-core) isn't loaded/ordered
      // before web — instead of a misordered config silently muting the agent. The
      // try/catch below is then just defensive (e.g. a malformed-ToolDef rejection).
      const sendTool: ToolDef = {
        name: SEND_MESSAGE_ACTION,
        description:
          "Send a message to the user in the web chat. This is the ONLY way to reach " +
          "them — your plain (non-tool) replies are never delivered.",
        parameters: {
          type: "object",
          properties: { text: { type: "string", description: "The message to show the user." } },
          required: ["text"],
        },
      };
      try {
        await actions.invoke("llm.register_tool", sendTool);
      } catch (err) {
        ctx.log.warn(`web: failed to register the web.send_message tool: ${String(err)}`);
      }

      // Contribute web's OWN channel guidance as a stable SYSTEM block: what this channel is
      // and that the agent reaches its user ONLY via the web.send_message tool. Channel-specific;
      // the general monologue/operating-model rule is the system-prompt plugin's job. Text and
      // priority are config-overridable (cfg.guidance / cfg.guidancePriority).
      ctx.setBlock({
        id: GUIDANCE_BLOCK_ID,
        // Label = id so the orchestrator wraps it as <web.guidance>…</web.guidance>.
        label: GUIDANCE_BLOCK_ID,
        target: "system",
        priority: cfg.guidancePriority ?? GUIDANCE_PRIORITY,
        render: (): string => cfg.guidance ?? DEFAULT_GUIDANCE,
      });

      // Contribute web's OWN chat history as the prompt's conversation (message-target
      // block). render() maps the live transcript to clean wire turns — a user message →
      // {role:"user"} tagged with the channel via `name`, an agent send → {role:"assistant"}
      // — so the model sees the dialogue without the monologue or tool mechanics. Reads
      // r.store live each beat; registered once.
      ctx.setBlock({
        id: CONVERSATION_BLOCK_ID,
        target: "messages",
        priority: CONVERSATION_PRIORITY,
        render: (): Message[] =>
          windowTranscript(r.store.list(), maxTurns, maxChars).map((e) =>
            e.role === "agent"
              ? { role: "assistant", content: e.text }
              : { role: "user", content: e.text, name: "web" },
          ),
      });

      // A new request snapshots the messages now in its composed context: those
      // pending messages are carried by THIS request and become its responsibility
      // (so an EARLIER outstanding request's return can't claim them).
      const offRequest = events.on(Events.LLM_REQUEST, (payload) => {
        const reqId = (payload as EventPayloads["llm.request"] | undefined)?.id;
        if (typeof reqId !== "string" || r.pending.length === 0) return;
        const prior = r.inFlight.get(reqId) ?? [];
        r.inFlight.set(reqId, prior.concat(r.pending));
        r.pending = [];
      });

      // A request's return means the beat that carried its messages completed →
      // flip exactly those messages to "read" (not any still-pending ones).
      const offReturn = events.on(Events.LLM_RETURN, (payload) => {
        const reqId = (payload as Reply<LLMResponse> | undefined)?.id;
        if (typeof reqId !== "string") return;
        const done = r.inFlight.get(reqId);
        if (!done) return;
        r.inFlight.delete(reqId);
        for (const id of done) {
          broadcast(r, { type: "status", id, status: "read" });
          // Also flip the in-memory transcript so a reconnect/replay shows "read"
          // immediately, and teardown's compacting rewrite bakes it onto disk (M-9).
          r.store.markRead(id);
        }
      });

      // Cleanup thunks for teardown: the three bus unsubscribes, plus dropping web's
      // two context blocks (the guidance + conversation blocks, registered above) via
      // the captured removeBlock.
      unsubs = [
        offSend,
        offRequest,
        offReturn,
        () => removeBlock(GUIDANCE_BLOCK_ID),
        () => removeBlock(CONVERSATION_BLOCK_ID),
      ];
      // Await the bind so the URL is announced within this agent's startup block
      // (the startup report indents it under the agent), with the real bound port.
      await ensureServer(port, host, tk, (line) => ctx.print(line));
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      // Note: offSend unregisters the web.send_message ACTION, but the ToolDef stays in
      // llm-core's per-Agent registry — there is no llm.unregister_tool, and llm-core
      // clears its whole tool map on its own teardown. The asymmetry is intentional.
      if (reg) {
        // Stop the async append chain, then synchronously rewrite the file from the
        // in-memory transcript — compacting it to <= MAX_TRANSCRIPT entries and baking
        // in current statuses (e.g. messages flipped to "read"), so it replays exactly
        // after a clean restart (M-9). Best-effort.
        reg.store.compactSync();
        // removeReg now owns SSE-client teardown (ends each open stream), so the
        // explicit loop that used to live here is gone. Order: unsubscribe (above)
        // → compactSync → removeReg (ends clients) → maybeStopServer (below).
        removeReg(reg.agentId);
        reg = undefined;
      }
      maybeStopServer();
    },
  };
};

export default createWeb;
