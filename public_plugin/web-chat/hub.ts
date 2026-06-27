/**
 * The web channel's process resource — the single `node:http` server shared and
 * refcounted by every per-Agent instance (one process owns one port). This is the
 * ONLY module-level state in the plugin: the server, the registry of live agents,
 * the message-id counter, and the per-process session token. Per-Agent mutable
 * state stays in each factory's closure (R6); the hub holds only an opaque
 * per-agent `AgentReg` so no Agent can observe another's input or output. Routing
 * is explicit by URL.
 *
 * Routes: GET / (the chat page) · GET /api/agents · POST /api/agents/:id/message
 * (-> the reg's deliver + a `sent` status; 404 unknown, 400 empty) ·
 * GET /api/agents/:id/stream (SSE: history, greeting, then live output + statuses).
 *
 * Security: the API is gated by a per-process session token. The token sources and
 * the constant-time compare are the shared primitives (../../shared/http-auth);
 * web's own policy is composed here — precedence query → bearer → cookie-RAW, and
 * OPEN when no token is configured.
 */
import * as http from "node:http";
import { bearerToken, queryToken, cookieToken, tokenOk } from "../../shared/http-auth";
import { PAGE_HTML } from "./page";
import { TranscriptStore } from "./transcript-store";

const COOKIE_NAME = "krakey_token";

export interface AgentReg {
  agentId: string;
  /** Deliver one browser message to THIS agent (emit input.message + wake the frame). */
  deliver: (text: string, msgId: number) => void;
  /** Open SSE responses streaming THIS agent's output + statuses. */
  clients: Set<http.ServerResponse>;
  /**
   * This agent's chat transcript + its bounded best-effort persistence (R6: each
   * agent keeps its own). Loaded from chat.jsonl at setup; replayed on connect.
   */
  store: TranscriptStore;
  /** Message ids appended to the queue, not yet carried by an LLM request. */
  pending: number[];
  /**
   * requestId -> message ids carried by THAT request's composed context, awaiting
   * THAT request's return. A frame ends at llm.request (returns can overlap and
   * arrive out of order), so a message is only `read` when the return of the
   * request that actually included it arrives — not any earlier outstanding one.
   */
  inFlight: Map<string, number[]>;
  /** The one-line greeting sent to a client on connect. */
  greeting: string;
}

// ---- module-level hub: the single owner of the process http server ----
let server: http.Server | undefined;
const regs = new Map<string, AgentReg>();
let msgSeq = 0;
/** The per-process session token gating every /api route (set when the server starts). */
let token = "";

/** Register an agent so the server routes to it; bumps the server refcount. */
export function addReg(reg: AgentReg): void {
  regs.set(reg.agentId, reg);
}

/**
 * Deregister an agent; the server is stopped once the last one detaches. Owns SSE
 * teardown: ends each of this agent's open stream responses (best-effort) before
 * dropping the reg, so teardown callers don't have to (parity with inspector's
 * hubDeregister).
 */
export function removeReg(agentId: string): void {
  const reg = regs.get(agentId);
  if (reg) {
    for (const res of reg.clients) {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
    regs.delete(agentId);
  }
}

/** Allocate the next message id (the POST handler's `++msgSeq`). Module-private — its only caller is the POST handler below. */
function bumpMsgSeq(): number {
  return ++msgSeq;
}

/** Seed the id counter past every persisted id so a restart can't reuse an id (M-8). */
export function seedMsgSeq(n: number): void {
  msgSeq = Math.max(msgSeq, n);
}

function sseSend(res: http.ServerResponse, event: unknown): void {
  try {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  } catch {
    /* client gone — dropped on its 'close' */
  }
}

/** Stream one SSE event to every open client of an agent. */
export function broadcast(reg: AgentReg, event: unknown): void {
  for (const res of reg.clients) sseSend(res, event);
}

/** Match /api/agents/:id/(message|stream). */
function agentRoute(pathname: string): { id: string; tail: "message" | "stream" } | undefined {
  const m = /^\/api\/agents\/([^/]+)\/(message|stream)$/.exec(pathname);
  if (!m) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    // Malformed %-escape in the agent-id segment → not a resolvable route; the
    // caller falls through to the final 404 (and the process stays alive).
    return undefined;
  }
  return { id, tail: m[2] as "message" | "stream" };
}

/** The token presented on a request: ?token=, `Authorization: Bearer`, or the cookie (read RAW). */
function presentedToken(req: http.IncomingMessage, search: string): string | undefined {
  return (
    queryToken(new URLSearchParams(search)) ??
    bearerToken(req) ??
    cookieToken(req, COOKIE_NAME, { decode: false })
  );
}

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Belt-and-suspenders: any unexpected throw in dispatch must degrade to a 400,
  // never bubble up as an uncaughtException that crashes the shared http.Server
  // (and the whole process). Best-effort — never rethrow.
  try {
    dispatch(req, res);
  } catch {
    if (!res.headersSent) {
      try {
        res.statusCode = 400;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "bad request" }));
      } catch {
        /* response may already be (partly) sent — nothing more we can do */
      }
    }
  }
}

function dispatch(req: http.IncomingMessage, res: http.ServerResponse): void {
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
    if (token && tokenOk(presented, token, { openWhenUnset: true })) {
      res.setHeader("set-cookie", COOKIE_NAME + "=" + token + "; HttpOnly; SameSite=Strict; Path=/");
    }
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGE_HTML);
    return;
  }

  // Everything else is the API — gated by the session token.
  if (!tokenOk(presented, token, { openWhenUnset: true })) {
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
      // Replay THIS agent's transcript first (always — `messages: []` when empty),
      // then the greeting, then live messages — so a reload/switch shows history.
      sseSend(res, {
        type: "history",
        messages: reg.store.list().map((e) => ({
          role: e.role,
          text: e.text,
          id: e.id,
          status: e.status,
        })),
      });
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
        const id = bumpMsgSeq();
        reg.pending.push(id);
        reg.store.append({ role: "user", text, id, status: "sent", at: Date.now() });
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
export function ensureServer(
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
export function maybeStopServer(): void {
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
