/**
 * Plugin: web — the browser chat channel.
 *
 * A sibling of any other channel behind the same input/output event seam: a typed
 * browser message becomes `input.message` (and wakes the beat via `clock.fire_now`);
 * `output.message` text is streamed back to the browser over SSE. Per message it
 * reports a delivery status — `sent` when the message is appended to the event
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
 * The default export is a PluginFactory — the loader calls it once per Agent; only
 * the hub (a process resource) is module-level. Persistence + the transcript live
 * in ./transcript-store; the HTTP/SSE server + auth live in ./hub.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { LLMResponse } from "../../contracts/llm";
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

const DEFAULT_PORT = 7717;
const DEFAULT_HOST = "127.0.0.1";

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
    manifest: { id: "web", version: "0.1.0" },

    async setup(ctx: PluginContext): Promise<void> {
      // Destructure the only ctx members the long-lived closures need, so the rest
      // of ctx (config, dataDir, print, …) can be GC'd once setup() returns instead
      // of being pinned for the agent's lifetime by the closures stored in `regs`.
      const { events, actions } = ctx;

      const cfg = (ctx.config ?? {}) as { port?: number; host?: string; token?: string };
      const port = typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;
      const host = typeof cfg.host === "string" && cfg.host ? cfg.host : DEFAULT_HOST;
      // A fresh random token per process unless a VALID one is pinned in config.
      // Accept the configured token only if it's a URL/cookie-safe string of length
      // ≥ 16; otherwise fall back to a random token (parity with inspector — an
      // invalid configured token is NOT adopted, so a request presenting it gets 401).
      const tk = validToken(cfg.token)
        ? (cfg.token as string)
        : crypto.randomBytes(24).toString("base64url");

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

      // Stream this agent's replies to its browser clients, persisting each.
      const offOutput = events.on(Events.OUTPUT_MESSAGE, (payload) => {
        const text = (payload as EventPayloads["output.message"])?.data?.text;
        if (typeof text === "string") {
          r.store.append({ role: "agent", text, at: Date.now() });
          broadcast(r, { type: "output", text });
        }
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

      unsubs = [offOutput, offRequest, offReturn];
      // Await the bind so the URL is announced within this agent's startup block
      // (the startup report indents it under the agent), with the real bound port.
      await ensureServer(port, host, tk, (line) => ctx.print(line));
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
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
