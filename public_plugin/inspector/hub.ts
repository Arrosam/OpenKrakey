/**
 * inspector/hub.ts — the process-wide HTTP resource behind the inspector plugin.
 *
 * Split out of index.ts (SRP). This file owns STORAGE + TRANSPORT: the wire
 * record/registration types, the refcounted singleton hub, the single request
 * router (serving every agent), the per-agent ring append + SSE fan-out, and the
 * refcounted register/deregister lifecycle. The plugin factory (index.ts) only
 * maps bus events into records and pushes them here.
 *
 * Auth precedence (Bearer → ?token= → inspector cookie) is composed here from the
 * shared, security-critical primitives in shared/http-auth; the gate is closed
 * when no token is configured (openWhenUnset defaults false).
 *
 * Behaviour is byte-for-byte unchanged from the pre-split implementation.
 */
import * as http from "node:http";
import { bearerToken, queryToken, cookieToken, tokenOk } from "../../shared/http-auth";
import { PAGE } from "./page";

/** The wire record the dashboard (and any observer) reads. Shape is contract. */
export interface EventRecord {
  seq: number;
  at: number;
  kind: string;
  agentId: string;
  corrId?: string;
  payload: unknown;
}

/** Per-agent registration kept inside the shared hub, keyed by agentId. */
export interface AgentReg {
  ring: EventRecord[];
  dropped: number;
  sseClients: Set<http.ServerResponse>;
}

/**
 * The process-wide refcounted hub. A single http.Server is shared by every
 * per-Agent instance in this process; `agents` routes requests by the :id in
 * the path. The first registration listens; the last deregistration closes.
 */
interface Hub {
  server: http.Server | null;
  /** Resolves once the (first) listen succeeds — awaited by every joiner. */
  listening: Promise<void> | null;
  agents: Map<string, AgentReg>;
  /** Process token — the first agent's token wins. */
  token: string;
  /** The port we actually bound (from server.address()); 0 until bound. */
  boundPort: number;
  host: string;
  refs: number;
}

// Module-level singleton (ESM caches the module, so this is one per process).
const hub: Hub = {
  server: null,
  listening: null,
  agents: new Map(),
  token: "",
  boundPort: 0,
  host: "127.0.0.1",
  refs: 0,
};

// ---- small helpers ----------------------------------------------------------

/** JSON.stringify that never throws (falls back to String()); shared by the
 *  router, the SSE fan-out, and index.ts's truncation byte-count. */
export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Pull a token from Authorization: Bearer, ?token=, or the inspector cookie. */
function extractToken(req: http.IncomingMessage, url: URL): string | undefined {
  return bearerToken(req) ?? queryToken(url.searchParams) ?? cookieToken(req, "inspector_token");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = safeStringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

// ---- the single request router (handles ALL agents) -------------------------

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Belt-and-suspenders: any unexpected throw in routing must degrade to a 400,
  // never bubble up to crash the shared http.Server (and the whole process).
  try {
    routeRequest(req, res);
  } catch {
    try {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("bad request");
    } catch {
      /* response may already be (partly) sent — nothing more we can do */
    }
  }
}

function routeRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));
  } catch {
    res.writeHead(404).end();
    return;
  }
  const path = url.pathname;
  const method = req.method || "GET";

  // GET / — the dashboard page. NOT token-gated. If a valid token is present,
  // set an HttpOnly cookie so subsequent EventSource/fetch calls authenticate.
  if (method === "GET" && path === "/") {
    const provided = extractToken(req, url);
    const headers: http.OutgoingHttpHeaders = {
      "content-type": "text/html; charset=utf-8",
      "content-length": Buffer.byteLength(PAGE),
    };
    if (tokenOk(provided, hub.token)) {
      headers["set-cookie"] = "inspector_token=" + encodeURIComponent(hub.token) +
        "; HttpOnly; SameSite=Strict; Path=/";
    }
    res.writeHead(200, headers);
    res.end(PAGE);
    return;
  }

  // Everything under /api/* is token-gated.
  if (path === "/api/agents" || path.startsWith("/api/agents/")) {
    if (!tokenOk(extractToken(req, url), hub.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    // GET /api/agents — list registered agent ids.
    if (method === "GET" && path === "/api/agents") {
      sendJson(res, 200, { agents: Array.from(hub.agents.keys()) });
      return;
    }

    // /api/agents/:id/(snapshot|stream)
    const rest = path.slice("/api/agents/".length);
    const slash = rest.indexOf("/");
    if (slash !== -1) {
      let id: string;
      try {
        id = decodeURIComponent(rest.slice(0, slash));
      } catch {
        // Malformed %-escape in the agent id segment → not a resolvable agent.
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const sub = rest.slice(slash + 1);
      const reg = hub.agents.get(id);

      // R6: only ever serve this agent's own AgentReg.
      if (method === "GET" && sub === "snapshot") {
        if (!reg) {
          sendJson(res, 404, { error: "unknown agent" });
          return;
        }
        sendJson(res, 200, { records: reg.ring.slice(), dropped: reg.dropped });
        return;
      }

      if (method === "GET" && sub === "stream") {
        if (!reg) {
          sendJson(res, 404, { error: "unknown agent" });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        // Prime the stream so the client's onopen fires promptly.
        res.write(": connected\n\n");
        reg.sseClients.add(res);
        req.on("close", () => {
          reg.sseClients.delete(res);
        });
        // Do NOT replay the ring here — the page backfills via /snapshot first.
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
    return;
  }

  // No POST, no other routes — read-only.
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

// ---- ring append + SSE fan-out (storage + transport) ------------------------

/**
 * Append a record to an agent's ring and fan it out to that agent's live SSE
 * clients. FIFO: when at capacity the oldest is dropped (and `dropped`
 * incremented) BEFORE pushing. Broken SSE clients are collected during the
 * write loop and reaped after it, never mutating the Set mid-iteration.
 */
export function pushRecord(reg: AgentReg, rec: EventRecord, bufferSize: number): void {
  // FIFO ring: drop the oldest BEFORE pushing when at capacity.
  while (reg.ring.length >= bufferSize) {
    reg.ring.shift();
    reg.dropped++;
  }
  reg.ring.push(rec);

  // Fan out to this agent's live SSE clients only (R6).
  const frame = "data: " + safeStringify({ type: "record", record: rec }) + "\n\n";
  let dead: http.ServerResponse[] | null = null;
  for (const client of reg.sseClients) {
    try {
      client.write(frame);
    } catch {
      // Reap a broken client; don't mutate the Set mid-iteration.
      (dead || (dead = [])).push(client);
    }
  }
  if (dead) for (const d of dead) reg.sseClients.delete(d);
}

// ---- hub lifecycle (refcounted) ---------------------------------------------

/** Register an agent; the FIRST registration creates + listens the server. */
export async function hubRegister(
  agentId: string,
  cfg: { port: number; host: string; token: string },
): Promise<{ reg: AgentReg; boundPort: number; token: string; created: boolean }> {
  let reg = hub.agents.get(agentId);
  if (!reg) {
    reg = { ring: [], dropped: 0, sseClients: new Set() };
    hub.agents.set(agentId, reg);
  }
  hub.refs++;

  // True only for the agent whose call actually created the shared server, so
  // the startup URL gets printed exactly once.
  const created = !hub.server;
  if (!hub.server) {
    // First agent in the process: it wins the token, host, and port.
    hub.token = cfg.token;
    hub.host = cfg.host;
    const server = http.createServer(handleRequest);
    hub.server = server;
    hub.listening = new Promise<void>((resolve) => {
      // Degrade (do not crash) on a listen error — e.g. a later rebind clash.
      server.once("error", () => {
        hub.boundPort = 0;
        resolve();
      });
      server.listen(cfg.port, cfg.host, () => {
        const addr = server.address();
        hub.boundPort = addr && typeof addr === "object" ? addr.port : cfg.port;
        resolve();
      });
    });
  }
  // Every joiner awaits the same listen promise (the first bound port wins).
  if (hub.listening) await hub.listening;

  return { reg, boundPort: hub.boundPort, token: hub.token, created };
}

/** Deregister an agent; the LAST deregistration closes the server. */
export function hubDeregister(agentId: string): void {
  const reg = hub.agents.get(agentId);
  if (reg) {
    for (const client of reg.sseClients) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
    }
    reg.sseClients.clear();
    hub.agents.delete(agentId);
  }
  hub.refs = Math.max(0, hub.refs - 1);
  if (hub.refs === 0 && hub.server) {
    const server = hub.server;
    hub.server = null;
    hub.listening = null;
    hub.boundPort = 0;
    try {
      // Force-drop lingering keep-alive sockets so the port frees promptly;
      // optional-chained because closeAllConnections is Node ≥18.2 only.
      server.closeAllConnections?.();
      server.close();
    } catch {
      /* ignore */
    }
  }
}
