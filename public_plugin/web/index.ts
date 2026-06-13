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
 * `node:http` server per process, owned by a MODULE-LEVEL hub shared + refcounted by every
 * per-Agent instance — the only legitimate process-singleton owner. Per-Agent
 * mutable state still lives in each factory closure (R6); the hub holds only an
 * opaque per-agent registry { agentId, deliver, sse-clients, pending } so no Agent
 * can observe another's input or output. Routing is explicit by URL.
 *
 * Routes: GET / (the chat page) · GET /api/agents · POST /api/agents/:id/message
 * (-> input.message + fire_now on that agent's bus; 404 unknown, 400 empty) ·
 * GET /api/agents/:id/stream (SSE: greeting, then that agent's output + statuses).
 *
 * Security: the server binds LOOPBACK by default (config.web.host, default
 * 127.0.0.1 — not all interfaces, so it is not LAN-reachable) and every /api/*
 * route requires a per-process SESSION TOKEN (random, or config.web.token). The
 * token is printed once with the URL — only the console that ran the program sees
 * it, so a random local process never learns it. GET / serves the page (no
 * secrets) and, when opened with the valid ?token=, sets an HttpOnly cookie so the
 * page's same-origin fetch/SSE authenticate automatically (no token in API URLs).
 * A token may also be presented via ?token= or `Authorization: Bearer`.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent; only
 * the hub (a process resource) is module-level.
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { LLMResponse } from "../../contracts/llm";
import { Actions, Events, type EventPayloads, type Reply } from "../../shared/actions";
import { PAGE_HTML } from "./page";

const DEFAULT_PORT = 7717;
const DEFAULT_HOST = "127.0.0.1";
const COOKIE_NAME = "krakey_token";

interface AgentReg {
  agentId: string;
  /** Deliver one browser message to THIS agent (emit input.message + wake the beat). */
  deliver: (text: string, msgId: number) => void;
  /** Open SSE responses streaming THIS agent's output + statuses. */
  clients: Set<http.ServerResponse>;
  /** Message ids appended to the queue but not yet processed (sent, awaiting read). */
  pending: number[];
  /** The one-line greeting sent to a client on connect. */
  greeting: string;
}

// ---- module-level hub: the single owner of the process http server ----
let server: http.Server | undefined;
const regs = new Map<string, AgentReg>();
let msgSeq = 0;
/** The per-process session token gating every /api route (set when the server starts). */
let token = "";

function sseSend(res: http.ServerResponse, event: unknown): void {
  try {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  } catch {
    /* client gone — dropped on its 'close' */
  }
}

function broadcast(reg: AgentReg, event: unknown): void {
  for (const res of reg.clients) sseSend(res, event);
}

/** Match /api/agents/:id/(message|stream). */
function agentRoute(pathname: string): { id: string; tail: "message" | "stream" } | undefined {
  const m = /^\/api\/agents\/([^/]+)\/(message|stream)$/.exec(pathname);
  if (!m) return undefined;
  return { id: decodeURIComponent(m[1]), tail: m[2] as "message" | "stream" };
}

/** The token presented on a request: ?token=, `Authorization: Bearer`, or the cookie. */
function presentedToken(req: http.IncomingMessage, search: string): string | undefined {
  const q = new URLSearchParams(search).get("token");
  if (q) return q;
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.headers["cookie"];
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const i = part.indexOf("=");
      if (i !== -1 && part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
    }
  }
  return undefined;
}

/** Constant-time check that the presented token matches the session token. */
function tokenOk(presented: string | undefined): boolean {
  if (!token) return true; // no token configured — open (should not happen in practice)
  if (typeof presented !== "string" || presented.length !== token.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(token));
  } catch {
    return false;
  }
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = req.url || "/";
  const qIdx = url.indexOf("?");
  const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
  const search = qIdx === -1 ? "" : url.slice(qIdx);
  const method = req.method || "GET";
  const presented = presentedToken(req, search);

  // The page itself holds no secrets, so it is served WITHOUT a token. When it is
  // opened with the valid token (the URL printed to the console), set an HttpOnly
  // cookie so the page's same-origin API calls authenticate without a token in
  // every URL.
  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    if (token && tokenOk(presented)) {
      res.setHeader("set-cookie", COOKIE_NAME + "=" + token + "; HttpOnly; SameSite=Strict; Path=/");
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE_HTML);
    return;
  }

  // Everything else is the API — gated by the session token.
  if (!tokenOk(presented)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if (method === "GET" && pathname === "/api/agents") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [...regs.keys()] }));
    return;
  }

  const route = agentRoute(pathname);
  if (route) {
    const reg = regs.get(route.id);
    if (!reg) {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "unknown agent: " + route.id }));
      return;
    }

    if (route.tail === "stream" && method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("connection", "keep-alive");
      res.write(": ok\n\n");
      sseSend(res, { type: "output", text: reg.greeting });
      reg.clients.add(res);
      req.on("close", () => reg.clients.delete(res));
      return;
    }

    if (route.tail === "message" && method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: { text?: unknown } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* invalid JSON -> empty */
        }
        const text = typeof body.text === "string" ? body.text.trim() : "";
        if (text === "") {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "empty message" }));
          return;
        }
        const id = ++msgSeq;
        reg.pending.push(id);
        reg.deliver(text, id);
        broadcast(reg, { type: "status", id, status: "sent" });
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id, status: "sent" }));
      });
      return;
    }
  }

  res.statusCode = 404;
  res.end("not found");
}

/**
 * Start the one server if it isn't up yet, and resolve once it is LISTENING — so
 * an `await`ing setup announces the URL synchronously within the agent's startup
 * block (not from a later async callback). The URL carries the real bound port
 * (works for an ephemeral port 0). A bind clash degrades (server dropped) and
 * still resolves so startup never hangs.
 */
function ensureServer(
  port: number,
  host: string,
  tokenValue: string,
  print: (line: string) => void,
): Promise<void> {
  if (server) return Promise.resolve();
  token = tokenValue; // process-level: set once, by the first agent to start the server
  return new Promise<void>((resolve) => {
    const s = http.createServer(handle);
    server = s;
    s.on("error", (err) => {
      if (server === s) server = undefined;
      print("✖ Web chat: could not bind " + host + ":" + port + " — " + err);
      resolve();
    });
    s.listen(port, host, () => {
      const addr = s.address();
      const bound = addr && typeof addr === "object" ? addr.port : port;
      // A loopback-reachable host for the printed URL (0.0.0.0/:: aren't dialable).
      const display = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
      print("✦ Web chat: http://" + display + ":" + bound + "/?token=" + token);
      resolve();
    });
  });
}

/** Close the server once the last agent has detached (refcount hits zero). */
function maybeStopServer(): void {
  if (regs.size === 0 && server) {
    const s = server;
    server = undefined;
    try {
      (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    } catch {
      /* older node: best effort */
    }
    s.close();
  }
}

const createWeb: PluginFactory = (): Plugin => {
  let reg: AgentReg | undefined;
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "web", version: "0.1.0" },

    async setup(ctx: PluginContext): Promise<void> {
      const cfg = (ctx.config ?? {}) as { port?: number; host?: string; token?: string };
      const port = typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;
      const host = typeof cfg.host === "string" && cfg.host ? cfg.host : DEFAULT_HOST;
      // A fresh random token per process unless one is pinned in config.
      const tk =
        typeof cfg.token === "string" && cfg.token
          ? cfg.token
          : crypto.randomBytes(24).toString("base64url");

      const r: AgentReg = {
        agentId: ctx.agentId,
        deliver: (text, msgId) => {
          const payload: EventPayloads["input.message"] = {
            at: Date.now(),
            data: { text, channel: "web", meta: { msgId } },
          };
          ctx.events.emit(Events.INPUT_MESSAGE, payload);
          if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
            ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
          }
        },
        clients: new Set(),
        pending: [],
        greeting: "agent '" + ctx.agentId + "' is awake — type to talk.",
      };
      reg = r;
      regs.set(ctx.agentId, r);

      // Stream this agent's replies to its browser clients.
      const offOutput = ctx.events.on(Events.OUTPUT_MESSAGE, (payload) => {
        const text = (payload as EventPayloads["output.message"])?.data?.text;
        if (typeof text === "string") broadcast(r, { type: "output", text });
      });

      // A completed beat (llm.return) means every queued message has now been
      // processed → flip the pending ones to "read".
      const offReturn = ctx.events.on(Events.LLM_RETURN, (payload) => {
        const reply = payload as Reply<LLMResponse> | undefined;
        if (!reply) return;
        const done = r.pending;
        r.pending = [];
        for (const id of done) broadcast(r, { type: "status", id, status: "read" });
      });

      unsubs = [offOutput, offReturn];
      // Await the bind so the URL is announced within this agent's startup block
      // (the startup report indents it under the agent), with the real bound port.
      await ensureServer(port, host, tk, (line) => ctx.print(line));
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      if (reg) {
        for (const res of reg.clients) {
          try {
            res.end();
          } catch {
            /* already closed */
          }
        }
        regs.delete(reg.agentId);
        reg = undefined;
      }
      maybeStopServer();
    },
  };
};

export default createWeb;
