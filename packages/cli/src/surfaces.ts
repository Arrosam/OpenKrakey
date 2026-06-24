/**
 * cli/surfaces — make the runtime's token-gated surfaces (web-chat, inspector)
 * reachable from the unified Console.
 *
 * Those surfaces are served by the RUNTIME (`krakey run`/`start`), a separate
 * process that mints a fresh random token per process unless one is pinned in the
 * agent's config slice. `krakey dashboard` only launches the Console + Config — it
 * never learns the runtime's random tokens, so the framed Chat/Inspector panels
 * load token-less and get rejected ("can't connect — token").
 *
 * The fix (B2): pin a STABLE token in the agent config. `ensureSurfaceTokens` mints
 * one per surface (into the FIRST agent that enables it — the one whose plugin wins
 * the process-level port bind) and persists it; both the runtime (at boot) and
 * `dashboard` (when building the framed URLs) then read the SAME token. Called by
 * `run`/`start` (so the persisted token exists before boot) and by `dashboard`.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

import { agentPaths } from "../../../shared/config";

/** One resolved surface: where it listens and the token that authenticates it. */
export interface SurfaceInfo {
  port: number;
  token: string;
}

/** The two framed runtime surfaces, keyed for the Console's URL env vars. */
export interface SurfaceTokens {
  chat?: SurfaceInfo;
  inspector?: SurfaceInfo;
}

/** The framed surfaces and their plugin id + default loopback port. */
const SURFACES: Array<{ key: keyof SurfaceTokens; plugin: string; defaultPort: number }> = [
  { key: "chat", plugin: "web-chat", defaultPort: 7718 },
  { key: "inspector", plugin: "inspector", defaultPort: 7719 },
];

/**
 * web-chat and inspector adopt a configured token ONLY if it's a URL/cookie-safe
 * string of length ≥ 16 (otherwise they fall back to a fresh random one). Mirror
 * that policy so a token we pin is one the plugin will actually honour.
 */
export function isValidSurfaceToken(t: unknown): t is string {
  return typeof t === "string" && t.length >= 16 && /^[A-Za-z0-9._~+\/=-]+$/.test(t);
}

/** Mint a token in the surfaces' accepted charset (base64url ⊂ the allowed set). */
function mintToken(): string {
  return randomBytes(24).toString("base64url");
}

/** Does this agent definition load `plugin` (as a normal or private plugin)? */
function enables(def: unknown, plugin: string): boolean {
  const d = def as { plugins?: unknown; privatePlugins?: unknown };
  return (
    (Array.isArray(d.plugins) && d.plugins.includes(plugin)) ||
    (Array.isArray(d.privatePlugins) && d.privatePlugins.includes(plugin))
  );
}

/**
 * For each framed surface, find the FIRST agent (readdir order — the same order
 * boot starts them, so the same one wins the port bind) that enables it, ensure its
 * config slice carries a valid token (minting + persisting if absent/invalid), and
 * return {port, token}. Idempotent: an already-valid token is left untouched and the
 * file is not rewritten. Best-effort: an unreadable agents dir / config, or a write
 * failure, never throws — it just yields no (or an in-memory) entry for that surface.
 */
export function ensureSurfaceTokens(agentsDir: string): SurfaceTokens {
  const out: SurfaceTokens = {};

  let ids: string[];
  try {
    ids = readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out; // no agents dir yet → nothing to wire
  }

  for (const surface of SURFACES) {
    for (const id of ids) {
      const cfgPath = agentPaths(agentsDir, id).config;
      let def: { config?: Record<string, unknown> } & Record<string, unknown>;
      try {
        def = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch {
        continue; // missing/garbled config → skip this agent
      }
      if (!enables(def, surface.plugin)) continue;

      // The first agent that enables the surface wins the process-level port bind,
      // so its token is the one the running server uses. Pin/read it here.
      const config =
        def.config && typeof def.config === "object" ? def.config : (def.config = {});
      const sliceRaw = config[surface.plugin];
      const slice = (sliceRaw && typeof sliceRaw === "object" ? sliceRaw : {}) as {
        port?: unknown;
        token?: unknown;
      };

      let token = slice.token;
      if (!isValidSurfaceToken(token)) {
        token = mintToken();
        slice.token = token;
        config[surface.plugin] = slice;
        try {
          writeFileSync(cfgPath, JSON.stringify(def, null, 2) + "\n", "utf8");
        } catch {
          // best-effort: fall through with the in-memory token so the Console can
          // still authenticate this session even if the file couldn't be written.
        }
      }

      const port = typeof slice.port === "number" ? slice.port : surface.defaultPort;
      out[surface.key] = { port, token: token as string };
      break; // only the first enabling agent matters
    }
  }

  return out;
}

/**
 * Build the loopback URL the Console should frame for a surface — with the
 * `?token=` query when we know it, else the bare URL (the panel will show
 * "Not connected" / a token prompt, the pre-fix behaviour).
 */
export function surfaceUrl(info: SurfaceInfo | undefined, defaultPort: number): string {
  const port = info?.port ?? defaultPort;
  const base = `http://127.0.0.1:${port}`;
  return info?.token ? `${base}/?token=${encodeURIComponent(info.token)}` : base;
}
