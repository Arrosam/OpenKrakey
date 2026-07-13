/**
 * console/server — the loopback `node:http` static server for the unified Krakey
 * Console. It serves ONE shell (a persistent top nav-bar + a Dashboard landing
 * that embeds the three web surfaces — config-web, the web chat channel, the
 * inspector — each in an <iframe> by URL).
 *
 * TOKEN-GATED. The served shell embeds the three framed surfaces' own tokened
 * URLs (via injectSurfaces → `window.__SURFACES__`), so the page itself is a
 * secret: anyone who can load it inherits authenticated access to Config, Chat
 * and Inspector. That is precisely why the shell must be gated — an open Console
 * page would leak those surface tokens to anyone who reached the port. So both
 * the shell (`GET /` and `/index.html`) and the read-only `GET /api/status`
 * require the per-process console token, checked with the shared constant-time
 * `tokenOk`. The token is accepted from the `?token=` query, an
 * `Authorization: Bearer` header, or a `console_token` cookie (in that
 * precedence). On a successful shell load we set that cookie (HttpOnly,
 * SameSite=Strict) so a reloaded tab re-authenticates without the query param.
 * Unknown paths stay 404 (the server is not blanket-401'd). static/ holds only
 * the injected index.html — there are no secret-free assets to leave open.
 *
 * The iframe children authenticate INDEPENDENTLY via their own baked `?token=`
 * URLs (carried in `window.__SURFACES__`), so gating the shell is not a
 * cross-origin cookie concern.
 *
 * `GET /api/status` is a read-only route that reports each surface's
 * reachability (checked server-side, so the online dots are accurate).
 *
 * The one dynamic render step: the served index.html gets the surface URLs
 * injected as `window.__SURFACES__ = {config,chat,inspector}` (in place of the
 * `<!--__SURFACES__-->` placeholder) so the page's iframes target whatever live
 * apps/ports the operator configured, never hardcoded values.
 */
import * as http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { bearerToken, queryToken, cookieToken, tokenOk } from "../../../shared/http-auth";

export interface ConsoleDeps {
  port: number;
  host: string;
  /** Absolute URL of the config-web app (the Config surface). */
  configUrl: string;
  /** Absolute URL of the web chat channel app (the Chat surface). */
  chatUrl: string;
  /** Absolute URL of the inspector app (the Inspector surface). */
  inspectorUrl: string;
  /**
   * The per-process console session token. Every request to the shell and to
   * `/api/status` must present it (query / bearer / cookie). Always set — the
   * bin mints one when none is configured, so the Console is never open.
   */
  token: string;
}

/** static/ lives beside src/ in the package; resolve it relative to this file. */
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");

/** The token in index.html that the injected <script> replaces. */
const SURFACES_PLACEHOLDER = "<!--__SURFACES__-->";

/** Name of the session cookie set on a successful shell load. */
const COOKIE_NAME = "console_token";

/**
 * The token this request presents, by source precedence: `?token=` query first,
 * then an `Authorization: Bearer` header, then the `console_token` cookie. The
 * cookie is decoded (default) so a value stored URL-encoded round-trips; the
 * cookie decode fails CLOSED (returns undefined) on a malformed escape. Returns
 * undefined when no source carries a token.
 */
function presentedToken(
  req: http.IncomingMessage,
  searchParams: URLSearchParams,
): string | undefined {
  return queryToken(searchParams) ?? bearerToken(req) ?? cookieToken(req, COOKIE_NAME, { decode: true });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

interface StaticAsset {
  body: Buffer;
  type: string;
}

/** Read every file in static/ into memory once, keyed by `/`-prefixed name. */
async function loadStatic(): Promise<Map<string, StaticAsset>> {
  const assets = new Map<string, StaticAsset>();
  const names = await readdir(STATIC_DIR);
  for (const name of names) {
    const body = await readFile(join(STATIC_DIR, name));
    const type = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
    assets.set("/" + name, { body, type });
  }
  return assets;
}

/**
 * Build the index.html the server actually serves: the static shell with the
 * surface URLs injected as `window.__SURFACES__`. The placeholder comment is
 * replaced (so the script lands in <head>); if for some reason it's missing we
 * fall back to prepending the script so the URLs always reach the page.
 *
 * The URLs are JSON-encoded and then have `<` escaped so a hostile value could
 * never break out of the <script> element — defence in depth (these come from
 * the operator's env, not the network).
 */
function injectSurfaces(html: string, deps: ConsoleDeps): string {
  const surfaces = { config: deps.configUrl, chat: deps.chatUrl, inspector: deps.inspectorUrl };
  const json = JSON.stringify(surfaces).replace(/</g, "\\u003c");
  const tag = "<script>window.__SURFACES__ = " + json + ";</script>";
  if (html.includes(SURFACES_PLACEHOLDER)) {
    return html.replace(SURFACES_PLACEHOLDER, tag);
  }
  return tag + html;
}

export async function startServer(
  deps: ConsoleDeps,
): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const assets = await loadStatic();
  const rawIndex = assets.get("/index.html");
  // Pre-render the served index once (URLs are fixed for the server's lifetime).
  const indexHtml = rawIndex ? injectSurfaces(rawIndex.body.toString("utf8"), deps) : undefined;
  const indexBody = indexHtml === undefined ? undefined : Buffer.from(indexHtml, "utf8");

  /**
   * Reachability of the three surfaces, checked SERVER-SIDE. A real fetch from the
   * Node process reads the actual connection — a live surface answers, a dead port
   * refuses — with none of the cross-origin/opaque-response ambiguity a browser
   * `no-cors` fetch suffers (which resolves for half-open sockets, so a stopped
   * surface can look "online"). The page polls this same-origin endpoint on a timer.
   */
  async function writeStatus(res: http.ServerResponse): Promise<void> {
    const reachable = async (u: string): Promise<boolean> => {
      try {
        await fetch(u, { signal: AbortSignal.timeout(2500) });
        return true; // ANY HTTP response (even 401/404) means the server is up
      } catch {
        return false; // connection refused / timeout / bad url → down
      }
    };
    const [config, chat, inspector] = await Promise.all([
      reachable(deps.configUrl),
      reachable(deps.chatUrl),
      reachable(deps.inspectorUrl),
    ]);
    const body = JSON.stringify({ config, chat, inspector });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    res.end(body);
  }

  const dispatch = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url || "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const search = qIdx === -1 ? "" : url.slice(qIdx + 1);
    const method = req.method || "GET";

    // The token this request presents (query → bearer → cookie). Computed for the
    // gated routes below; unknown paths are 404'd before we ever consult it.
    const authed = (): boolean =>
      tokenOk(presentedToken(req, new URLSearchParams(search)), deps.token);

    // A minimal, secret-free 401 for the gated routes. It names how to obtain the
    // tokened URL but leaks NO surface URL or token (that is exactly what gating
    // the shell protects).
    const lock = (res: http.ServerResponse): void => {
      const body =
        "unauthorized — open the tokened URL printed by `krakey dashboard` / `npm run console`";
      res.writeHead(401, {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      res.end(body);
    };

    // GET /api/status — server-side reachability of the three surfaces (JSON).
    // Gated: an untokened caller must not learn the surfaces' reachability.
    if (method === "GET" && pathname === "/api/status") {
      if (!authed()) {
        lock(res);
        return;
      }
      writeStatus(res).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end('{"config":false,"chat":false,"inspector":false}');
        }
      });
      return;
    }

    // GET / (and /index.html) — the shell, with surface URLs injected.
    // Gated: the injected shell embeds the framed surfaces' tokens, so an
    // untokened caller gets the lock body and NEVER the shell HTML.
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      if (!authed()) {
        lock(res);
        return;
      }
      if (!indexBody) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("index.html missing");
        return;
      }
      // Set the session cookie so a reloaded tab re-authenticates without the
      // `?token=` query. The VALUE is the token itself, so it round-trips through
      // tokenOk on the follow-up request. HttpOnly (no script access), Strict (not
      // sent cross-site), Path=/ (covers the whole origin).
      const cookie =
        COOKIE_NAME + "=" + deps.token + "; HttpOnly; SameSite=Strict; Path=/";
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": indexBody.length,
        "set-cookie": cookie,
      });
      res.end(indexBody);
      return;
    }

    // Other static assets (styles.css, app.js, svg…) — served as-is.
    const asset = assets.get(pathname);
    if (method === "GET" && asset) {
      res.writeHead(200, {
        "content-type": asset.type,
        "content-length": asset.body.length,
      });
      res.end(asset.body);
      return;
    }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  };

  // Belt-and-suspenders: a throw in routing degrades to 400, never crashes the
  // process.
  const handle = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    try {
      dispatch(req, res);
    } catch {
      if (!res.headersSent) {
        try {
          res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
          res.end("bad request");
        } catch {
          /* response may already be (partly) sent */
        }
      }
    }
  };

  const server = http.createServer(handle);

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.port, deps.host, () => {
      server.removeListener("error", reject);
      const addr = server.address();
      resolve(addr && typeof addr === "object" ? addr.port : deps.port);
    });
  });

  // A loopback-reachable host for the returned URL (0.0.0.0 / :: aren't dialable
  // in a browser). The startup line is printed by bin.ts (the entry point) — this
  // library function stays silent so callers (incl. tests that start many
  // servers) never spam stdout.
  const display = deps.host === "0.0.0.0" || deps.host === "::" ? "127.0.0.1" : deps.host;
  // The URL carries the token so the printed/opened link authenticates on first
  // load (which also sets the console_token cookie for subsequent reloads).
  const url = "http://" + display + ":" + port + "/?token=" + encodeURIComponent(deps.token);

  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* older node: best effort */
      }
      server.close(() => resolve());
    });

  return { port, url, close };
}
