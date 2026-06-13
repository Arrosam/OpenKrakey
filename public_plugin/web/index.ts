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
 * The default export is a PluginFactory — the loader calls it once per Agent; only
 * the hub (a process resource) is module-level.
 */
import * as http from "node:http";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { LLMResponse } from "../../contracts/llm";
import { Actions, Events, type EventPayloads, type Reply } from "../../shared/actions";
import { PAGE_HTML } from "./page";

const DEFAULT_PORT = 7717;

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

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  const pathname = (req.url || "/").split("?")[0];
  const method = req.method || "GET";

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE_HTML);
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

/** Start the one server if it isn't up yet; print its URL via the agent's sink. */
function ensureServer(port: number, print: (line: string) => void): void {
  if (server) return;
  const s = http.createServer(handle);
  server = s;
  s.on("error", () => {
    // A port clash (e.g. two agents, second with a different port) must not crash
    // startup — degrade: the first server stays, this attempt is dropped.
    if (server === s) server = undefined;
  });
  s.listen(port, () => {
    const addr = s.address();
    const bound = addr && typeof addr === "object" ? addr.port : port;
    print("✦ Web chat: http://localhost:" + bound);
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

    setup(ctx: PluginContext): void {
      const cfg = (ctx.config ?? {}) as { port?: number };
      const port = typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;

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
      ensureServer(port, (line) => ctx.print(line));
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
