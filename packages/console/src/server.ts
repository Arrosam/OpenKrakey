/**
 * console/server — the loopback `node:http` static server for the unified Krakey
 * Console. It serves ONE shell (a persistent top nav-bar + a Dashboard landing
 * that embeds the three web surfaces — config-web, the web chat channel, the
 * inspector — each in an <iframe> by URL).
 *
 * This is intentionally SIMPLER than config-web's server: there is NO /api, NO
 * token gating, NO cookie. Every route just serves a static asset preloaded into
 * memory. The shell holds no secrets — the surface URLs are non-secret config.
 *
 * The one dynamic step: the served index.html gets the surface URLs injected as
 * `window.__SURFACES__ = {config,chat,inspector}` (in place of the
 * `<!--__SURFACES__-->` placeholder) so the page's iframes target whatever live
 * apps/ports the operator configured, never hardcoded values.
 */
import * as http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

export interface ConsoleDeps {
  port: number;
  host: string;
  /** Absolute URL of the config-web app (the Config surface). */
  configUrl: string;
  /** Absolute URL of the web chat channel app (the Chat surface). */
  chatUrl: string;
  /** Absolute URL of the inspector app (the Inspector surface). */
  inspectorUrl: string;
}

/** static/ lives beside src/ in the package; resolve it relative to this file. */
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");

/** The token in index.html that the injected <script> replaces. */
const SURFACES_PLACEHOLDER = "<!--__SURFACES__-->";

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

  const dispatch = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url || "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const method = req.method || "GET";

    // GET / (and /index.html) — the shell, with surface URLs injected.
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      if (!indexBody) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("index.html missing");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": indexBody.length,
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
  const url = "http://" + display + ":" + port + "/";

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
