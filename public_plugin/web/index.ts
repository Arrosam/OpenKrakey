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
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { LLMResponse } from "../../contracts/llm";
import { Actions, Events, type EventPayloads, type Reply } from "../../shared/actions";
import { PAGE_HTML } from "./page";

const DEFAULT_PORT = 7717;
const DEFAULT_HOST = "127.0.0.1";
const COOKIE_NAME = "krakey_token";
/** Hard cap on transcript entries kept in memory and rewritten to disk (bounds replay + file growth). */
const MAX_TRANSCRIPT = 1000;

/**
 * One persisted line of an agent's chat transcript (the chat.jsonl wire shape).
 * `id`/`status` are present only for user messages (carried so a replayed `sent`
 * tick survives a reload); agent messages have just role/text/at.
 */
interface TranscriptEntry {
  role: "user" | "agent";
  text: string;
  id?: number;
  status?: string;
  at: number;
}

interface AgentReg {
  agentId: string;
  /** Deliver one browser message to THIS agent (emit input.message + wake the beat). */
  deliver: (text: string, msgId: number) => void;
  /** Open SSE responses streaming THIS agent's output + statuses. */
  clients: Set<http.ServerResponse>;
  /**
   * This agent's chat transcript, replayed to a browser on connect (R6: each agent
   * keeps its own). Loaded from chat.jsonl at setup and appended to as messages flow.
   */
  transcript: TranscriptEntry[];
  /** Absolute path of this agent's chat.jsonl under ctx.dataDir (agent-isolated at runtime). */
  chatPath: string;
  /**
   * Serialized async append chain: each `record` chains its file write onto the
   * prior one so writes never interleave and never block delivery (M-7). Errors are
   * swallowed (best-effort persistence). Goes inert once `closed` is set (teardown).
   */
  writing: Promise<void>;
  /** Set true in teardown so any in-flight async append no-ops, leaving the sync rewrite authoritative. */
  closed: boolean;
  /** Message ids appended to the queue, not yet carried by an LLM request. */
  pending: number[];
  /**
   * requestId -> message ids carried by THAT request's composed context, awaiting
   * THAT request's return. A beat ends at llm.request (returns can overlap and
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

/**
 * Append one entry to the agent's in-memory transcript AND its chat.jsonl. The
 * in-memory transcript is capped at MAX_TRANSCRIPT (oldest dropped) so both replay
 * and the on-disk rewrite stay bounded (H-3). The file write is async and serialized
 * onto reg.writing so it never blocks delivery and writes never interleave (M-7); a
 * disk error is swallowed (best-effort persistence) and once reg.closed is set the
 * append is skipped, leaving teardown's sync rewrite authoritative (M-9).
 */
function record(reg: AgentReg, entry: TranscriptEntry): void {
  reg.transcript.push(entry);
  if (reg.transcript.length > MAX_TRANSCRIPT) reg.transcript.shift();
  reg.writing = reg.writing
    .then(() =>
      reg.closed ? undefined : fs.promises.appendFile(reg.chatPath, JSON.stringify(entry) + "\n"),
    )
    .catch(() => {});
}

/**
 * Load a chat.jsonl into a transcript array, one JSON object per line; skip malformed
 * lines and keep only the LAST MAX_TRANSCRIPT valid entries (H-3 bound). Each kept
 * entry preserves its `id`/`status` so a persisted `sent`/`read` tick replays after a
 * restart (M-9). Async read — never blocks the event loop.
 */
async function loadTranscript(chatPath: string): Promise<TranscriptEntry[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(chatPath, "utf8");
  } catch {
    return []; // no history yet (or unreadable) — start empty
  }
  const out: TranscriptEntry[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s) as TranscriptEntry;
      if (e && (e.role === "user" || e.role === "agent") && typeof e.text === "string") out.push(e);
    } catch {
      /* ignore a malformed line */
    }
  }
  return out.length > MAX_TRANSCRIPT ? out.slice(out.length - MAX_TRANSCRIPT) : out;
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
      // Replay THIS agent's transcript first (always — `messages: []` when empty),
      // then the greeting, then live messages — so a reload/switch shows history.
      sseSend(res, {
        type: "history",
        messages: reg.transcript.map((e) => ({
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
        const id = ++msgSeq;
        reg.pending.push(id);
        record(reg, { role: "user", text, id, status: "sent", at: Date.now() });
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

      // Ensure the per-plugin (agent-isolated) data dir exists, then load any prior
      // transcript so history survives a restart. Best-effort: a dir/read failure
      // just starts the agent with an empty transcript.
      const chatPath = path.join(ctx.dataDir, "chat.jsonl");
      try {
        fs.mkdirSync(ctx.dataDir, { recursive: true });
      } catch {
        /* best-effort: an unwritable dataDir degrades to in-memory only */
      }

      const transcript = await loadTranscript(chatPath);
      // Seed the module-global id counter past every persisted id so a new message
      // can never reuse an id that survived a restart (M-8 collision).
      for (const e of transcript) {
        if (typeof e.id === "number") msgSeq = Math.max(msgSeq, e.id);
      }

      const r: AgentReg = {
        agentId: ctx.agentId,
        transcript,
        chatPath,
        writing: Promise.resolve(),
        closed: false,
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
        inFlight: new Map(),
        greeting: "agent '" + ctx.agentId + "' is awake — type to talk.",
      };
      reg = r;
      regs.set(ctx.agentId, r);

      // Stream this agent's replies to its browser clients, persisting each.
      const offOutput = ctx.events.on(Events.OUTPUT_MESSAGE, (payload) => {
        const text = (payload as EventPayloads["output.message"])?.data?.text;
        if (typeof text === "string") {
          record(r, { role: "agent", text, at: Date.now() });
          broadcast(r, { type: "output", text });
        }
      });

      // A new request snapshots the messages now in its composed context: those
      // pending messages are carried by THIS request and become its responsibility
      // (so an EARLIER outstanding request's return can't claim them).
      const offRequest = ctx.events.on(Events.LLM_REQUEST, (payload) => {
        const reqId = (payload as EventPayloads["llm.request"] | undefined)?.id;
        if (typeof reqId !== "string" || r.pending.length === 0) return;
        const prior = r.inFlight.get(reqId) ?? [];
        r.inFlight.set(reqId, prior.concat(r.pending));
        r.pending = [];
      });

      // A request's return means the beat that carried its messages completed →
      // flip exactly those messages to "read" (not any still-pending ones).
      const offReturn = ctx.events.on(Events.LLM_RETURN, (payload) => {
        const reqId = (payload as Reply<LLMResponse> | undefined)?.id;
        if (typeof reqId !== "string") return;
        const done = r.inFlight.get(reqId);
        if (!done) return;
        r.inFlight.delete(reqId);
        for (const id of done) {
          broadcast(r, { type: "status", id, status: "read" });
          // Also flip the in-memory transcript so a reconnect/replay shows "read"
          // immediately, and teardown's compacting rewrite bakes it onto disk (M-9).
          const t = r.transcript.find((e) => e.id === id);
          if (t) t.status = "read";
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
        // after a clean restart (M-9). Setting `closed` first makes any in-flight async
        // append a no-op, leaving this sync write authoritative. Best-effort.
        reg.closed = true;
        try {
          fs.writeFileSync(
            reg.chatPath,
            reg.transcript.map((e) => JSON.stringify(e)).join("\n") +
              (reg.transcript.length ? "\n" : ""),
          );
        } catch {
          /* persistence is best-effort — a write failure must not break shutdown */
        }
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
