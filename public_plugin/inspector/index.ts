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
 */
import * as http from "node:http";
import * as crypto from "node:crypto";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import { Events } from "../../shared/actions";
import { PAGE } from "./page";

/** The wire record the dashboard (and any observer) reads. Shape is contract. */
interface EventRecord {
  seq: number;
  at: number;
  kind: string;
  agentId: string;
  corrId?: string;
  payload: unknown;
}

/** Per-agent registration kept inside the shared hub, keyed by agentId. */
interface AgentReg {
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

/**
 * Default loopback port. Deliberately distinct from web's default (7717) so the
 * inspector never collides with it on a stock config.
 */
const DEFAULT_PORT = 7788;

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

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Constant-time token comparison; unequal lengths fail closed. */
function tokenOk(provided: string | undefined): boolean {
  if (!provided || !hub.token) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(hub.token);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Pull a token from Authorization: Bearer, ?token=, or the inspector cookie. */
function extractToken(req: http.IncomingMessage, url: URL): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  const q = url.searchParams.get("token");
  if (q) return q;
  const cookie = req.headers["cookie"];
  if (typeof cookie === "string") {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      const k = part.slice(0, eq).trim();
      if (k === "inspector_token") return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
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
    if (tokenOk(provided)) {
      headers["set-cookie"] = "inspector_token=" + encodeURIComponent(hub.token) +
        "; HttpOnly; SameSite=Strict; Path=/";
    }
    res.writeHead(200, headers);
    res.end(PAGE);
    return;
  }

  // Everything under /api/* is token-gated.
  if (path === "/api/agents" || path.startsWith("/api/agents/")) {
    if (!tokenOk(extractToken(req, url))) {
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
      const id = decodeURIComponent(rest.slice(0, slash));
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

// ---- hub lifecycle (refcounted) ---------------------------------------------

/** Register an agent; the FIRST registration creates + listens the server. */
async function hubRegister(
  agentId: string,
  cfg: { port: number; host: string; token: string },
): Promise<{ reg: AgentReg; boundPort: number; token: string }> {
  let reg = hub.agents.get(agentId);
  if (!reg) {
    reg = { ring: [], dropped: 0, sseClients: new Set() };
    hub.agents.set(agentId, reg);
  }
  hub.refs++;

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

  return { reg, boundPort: hub.boundPort, token: hub.token };
}

/** Deregister an agent; the LAST deregistration closes the server. */
function hubDeregister(agentId: string): void {
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
      server.close();
    } catch {
      /* ignore */
    }
  }
}

// ---- the plugin factory ------------------------------------------------------

const manifest = { id: "inspector", version: "0.1.0" };

/** Map each captured event name onto its dashboard `kind`. */
const KIND: { [eventName: string]: string } = {
  [Events.AGENT_START]: "agent.start",
  [Events.CLOCK_TICK]: "tick",
  [Events.PROMPT_GATHER]: "gather",
  [Events.LLM_REQUEST]: "prompt.sent",
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

    // ---- config resolution (merge nested-over-flat) ----
    const c = (ctx.config ?? {}) as any;
    const slice = {
      ...(typeof c === "object" ? c : {}),
      ...((c && c.inspector) || {}),
    };
    const port: number = slice.port ?? DEFAULT_PORT;
    const host: string = slice.host ?? "127.0.0.1";
    let token: string = slice.token ?? crypto.randomBytes(24).toString("base64url");
    if (typeof token !== "string" || token.length < 16) {
      token = crypto.randomBytes(24).toString("base64url");
    }
    const bufferSize: number = slice.bufferSize ?? 1000;
    const maxRecordBytes: number = slice.maxRecordBytes ?? 65536;

    // ---- join the refcounted hub (first registration listens) ----
    const joined = await hubRegister(agentId, { port, host, token });
    reg = joined.reg;
    const boundPort = joined.boundPort;
    // The process token is whatever the first agent set; use it in our URL.
    const procToken = joined.token;

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

          let recPayload: unknown = payload;
          const json = safeStringify(payload);
          if (json.length > maxRecordBytes) {
            const slc = json.slice(0, maxRecordBytes);
            recPayload = slc + "…[truncated " + (json.length - maxRecordBytes) + " bytes]";
          }

          const rec: EventRecord = {
            seq: seq++,
            at: Date.now(),
            kind,
            agentId,
            corrId,
            payload: recPayload,
          };

          // FIFO ring: drop the oldest BEFORE pushing when at capacity.
          if (reg) {
            while (reg.ring.length >= bufferSize) {
              reg.ring.shift();
              reg.dropped++;
            }
            reg.ring.push(rec);

            // Fan out to this agent's live SSE clients only (R6).
            const frame = "data: " + safeStringify({ type: "record", record: rec }) + "\n\n";
            for (const client of reg.sseClients) {
              try {
                client.write(frame);
              } catch {
                /* a dead client is reaped on its own close event */
              }
            }
          }
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
    ctx.print("✦ Inspector: http://" + host + ":" + boundPort + "/?token=" + procToken);
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
    // End this agent's SSE clients and drop us from the hub; the hub closes the
    // server once the last agent leaves.
    if (reg) {
      for (const client of reg.sseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
    }
    if (agentId) hubDeregister(agentId);
    reg = null;
  }

  return { manifest, setup, teardown };
};

export default factory;
