/**
 * config-web/server — the loopback `node:http` server. It serves the static SPA
 * (preloaded into memory at startup) and routes `/api/*` to the JSON handler.
 *
 * Security mirrors the inspector's CLOSED-when-unset policy: a token MUST be set
 * for the API to answer. The token is accepted via `?token=`, a Bearer header,
 * or a cookie. When the page is opened with a valid token we set an HttpOnly
 * SameSite=Strict cookie so the SPA's same-origin fetch calls authenticate
 * without a token in every URL.
 */
import * as http from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

import { bearerToken, queryToken, cookieToken, tokenOk } from "../../../shared/http-auth";

import { createApiHandler } from "./api";

const COOKIE_NAME = "config_web_token";

export interface ConfigWebDeps {
  port: number;
  host: string;
  token: string;
  agentsDir: string;
  defaultPath: string;
  publicPluginDir: string;
  llmPath: string;
}

/** static/ lives beside src/ in the package; resolve it relative to this file. */
const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "static");

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

/** The token presented on a request: ?token=, Bearer, or the cookie. */
function presentedToken(req: http.IncomingMessage, search: string): string | undefined {
  return (
    queryToken(new URLSearchParams(search)) ??
    bearerToken(req) ??
    cookieToken(req, COOKIE_NAME, { decode: false })
  );
}

export async function startServer(
  deps: ConfigWebDeps,
): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const assets = await loadStatic();
  const index = assets.get("/index.html");
  const api = createApiHandler({
    agentsDir: deps.agentsDir,
    defaultPath: deps.defaultPath,
    publicPluginDir: deps.publicPluginDir,
    llmPath: deps.llmPath,
  });

  const dispatch = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url || "/";
    const qIdx = url.indexOf("?");
    const pathname = qIdx === -1 ? url : url.slice(0, qIdx);
    const search = qIdx === -1 ? "" : url.slice(qIdx);
    const method = req.method || "GET";
    const presented = presentedToken(req, search);

    // GET / (and /index.html) — the SPA shell. Not token-gated (it holds no
    // secrets), but when opened with the valid token we plant the auth cookie so
    // same-origin API calls work without a token in the URL.
    if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      if (!index) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end("index.html missing");
        return;
      }
      const headers: http.OutgoingHttpHeaders = {
        "content-type": index.type,
        "content-length": index.body.length,
      };
      if (tokenOk(presented, deps.token)) {
        headers["set-cookie"] =
          COOKIE_NAME + "=" + deps.token + "; HttpOnly; SameSite=Strict; Path=/";
      }
      res.writeHead(200, headers);
      res.end(index.body);
      return;
    }

    // Other static assets (app.js, styles.css…) — served as-is, not gated.
    const asset = assets.get(pathname);
    if (method === "GET" && asset) {
      res.writeHead(200, {
        "content-type": asset.type,
        "content-length": asset.body.length,
      });
      res.end(asset.body);
      return;
    }

    // Everything under /api/* requires a valid token (CLOSED when unset).
    if (pathname.startsWith("/api/")) {
      if (!tokenOk(presented, deps.token)) {
        const text = JSON.stringify({ error: "unauthorized" });
        res.writeHead(401, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(text),
        });
        res.end(text);
        return;
      }
      api(method, pathname, search, req, res);
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
  const url = "http://" + display + ":" + port + "/?token=" + deps.token;

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
