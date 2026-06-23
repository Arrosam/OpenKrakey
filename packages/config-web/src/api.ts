/**
 * config-web/api — the loopback JSON API. It is a thin REST face over the shared
 * config-ops `Cli` surface (the SAME file operations the interactive cli drives),
 * plus the schema-assembly endpoint. No fs logic lives here — every read/write
 * delegates to `createCli`, so the web tool and the cli can never drift.
 *
 * Error mapping is uniform: a CliParseError (a file holds invalid JSON) → 422; a
 * CliError (missing file / not found / invalid id) → 404; a malformed request
 * body → 400; anything unexpected → 500. The handler never throws to the caller —
 * the server's router stays alive.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { createCli, CliError, CliParseError } from "../../../shared/config-ops";
import type { AgentDefinition } from "../../../contracts/agent";
import type { DefaultAgentSetting, LLMConfig } from "../../../shared/config";

import { assembleSchema } from "./schema-loader";

interface ApiDeps {
  agentsDir: string;
  defaultPath: string;
  publicPluginDir: string;
  llmPath: string;
}

type Handler = (
  method: string,
  pathname: string,
  search: string,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Map any thrown error to the right JSON status. */
function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof CliParseError) {
    sendJson(res, 422, { error: err.message });
    return;
  }
  if (err instanceof CliError) {
    sendJson(res, 404, { error: err.message });
    return;
  }
  sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
}

/** Read the whole request body and JSON.parse it. Rejects on invalid JSON. */
function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        reject(new SyntaxError("malformed JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Probe a provider's model catalogue SERVER-SIDE (so the browser never makes a
 * cross-origin call). Provider-aware: OpenAI-compatible → GET {baseURL}/models
 * (Bearer key); Anthropic → GET {base}/v1/models (x-api-key). Returns model ids.
 * The apiKey is used AS GIVEN — a literal key works; a `${ENV}` reference is not
 * resolved here, so probe with a literal key.
 */
async function probeModels(body: {
  provider?: string;
  baseURL?: string;
  apiKey?: string;
}): Promise<string[]> {
  const provider = typeof body.provider === "string" ? body.provider : "";
  const baseURL = typeof body.baseURL === "string" ? body.baseURL.trim() : "";
  const key = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const trimRight = (u: string): string => u.replace(/\/+$/, "");

  let url: string;
  const headers: Record<string, string> = { accept: "application/json" };

  if (provider === "anthropic") {
    const base = trimRight(baseURL || "https://api.anthropic.com");
    url = (/\/v\d+$/.test(base) ? base : base + "/v1") + "/models";
    if (key) headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (provider === "openai-completion" || provider === "openai-responses") {
    url = trimRight(baseURL || "https://api.openai.com/v1") + "/models";
    if (key) headers["authorization"] = "Bearer " + key;
  } else {
    throw new Error('fetching models is not supported for provider "' + (provider || "?") + '"');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let resp: Response;
  try {
    resp = await fetch(url, { headers, signal: controller.signal });
  } catch (e) {
    throw new Error("could not reach " + url + " — " + (e instanceof Error ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error("provider returned HTTP " + resp.status + (text ? " — " + text.slice(0, 200) : ""));
  }
  const json = (await resp.json().catch(() => null)) as unknown;
  const arr =
    json && typeof json === "object" && Array.isArray((json as { data?: unknown }).data)
      ? (json as { data: unknown[] }).data
      : Array.isArray(json)
        ? (json as unknown[])
        : [];
  const ids: string[] = [];
  for (const m of arr) {
    if (typeof m === "string") ids.push(m);
    else if (m && typeof m === "object" && typeof (m as { id?: unknown }).id === "string") {
      ids.push((m as { id: string }).id);
    }
  }
  return ids;
}

export function createApiHandler(deps: ApiDeps): Handler {
  // One Cli for the whole process — it is stateless over plain fs calls.
  const cli = createCli({
    agentsDir: deps.agentsDir,
    defaultPath: deps.defaultPath,
    publicPluginDir: deps.publicPluginDir,
    llmPath: deps.llmPath,
  });

  return (method, pathname, _search, req, res): void => {
    // Run an async route, funnelling every failure through the right status.
    // `res` is captured per-request (no shared mutable handle) so overlapping
    // requests can never cross responses.
    const guard = (fn: () => Promise<void>): void => {
      fn().catch((err) => {
        // A malformed JSON body is a client error, distinct from a CliError.
        if (err instanceof SyntaxError) {
          sendJson(res, 400, { error: "malformed JSON body" });
          return;
        }
        sendError(res, err);
      });
    };

    // GET /api/schema — the auto-render payload.
    if (method === "GET" && pathname === "/api/schema") {
      guard(async () => {
        const payload = await assembleSchema({ publicPluginDir: deps.publicPluginDir });
        sendJson(res, 200, payload);
      });
      return;
    }

    // GET /api/plugins — available public plugin ids.
    if (method === "GET" && pathname === "/api/plugins") {
      guard(async () => {
        const plugins = await cli.listAvailablePlugins();
        sendJson(res, 200, { plugins });
      });
      return;
    }

    // /api/llm — the LLM communicator catalogue.
    if (pathname === "/api/llm") {
      if (method === "GET") {
        guard(async () => sendJson(res, 200, await cli.readLLMConfig()));
        return;
      }
      if (method === "PUT") {
        guard(async () => {
          const body = await readJsonBody<LLMConfig>(req);
          await cli.writeLLMConfig(body);
          sendJson(res, 200, { ok: true });
        });
        return;
      }
    }

    // POST /api/provider-models — probe a provider's model catalogue (server-side,
    // no browser CORS). Body: { provider, baseURL, apiKey }.
    if (method === "POST" && pathname === "/api/provider-models") {
      guard(async () => {
        const body = await readJsonBody<{ provider?: string; baseURL?: string; apiKey?: string }>(req);
        sendJson(res, 200, { models: await probeModels(body) });
      });
      return;
    }

    // /api/default — the Default Plugin Setting.
    if (pathname === "/api/default") {
      if (method === "GET") {
        guard(async () => sendJson(res, 200, await cli.readDefault()));
        return;
      }
      if (method === "PUT") {
        guard(async () => {
          const body = await readJsonBody<DefaultAgentSetting>(req);
          await cli.writeDefault(body);
          sendJson(res, 200, { ok: true });
        });
        return;
      }
    }

    // GET /api/agents — the list.
    if (method === "GET" && pathname === "/api/agents") {
      guard(async () => {
        const agents = await cli.listAgents();
        sendJson(res, 200, { agents });
      });
      return;
    }

    // /api/agents/:id  and  /api/agents/:id/create
    if (pathname.startsWith("/api/agents/")) {
      const rest = pathname.slice("/api/agents/".length);
      const slash = rest.indexOf("/");

      // POST /api/agents/:id/create
      if (slash !== -1) {
        const id = decodeIdSafe(rest.slice(0, slash));
        const sub = rest.slice(slash + 1);
        if (method === "POST" && sub === "create") {
          guard(async () => {
            if (id === undefined) throw new CliError("not found");
            await cli.createAgent(id);
            sendJson(res, 201, { ok: true });
          });
          return;
        }
        sendJson(res, 404, { error: "not found" });
        return;
      }

      const id = decodeIdSafe(rest);
      if (method === "GET") {
        guard(async () => {
          if (id === undefined) throw new CliError("not found");
          sendJson(res, 200, await cli.readAgent(id));
        });
        return;
      }
      if (method === "PUT") {
        guard(async () => {
          if (id === undefined) throw new CliError("not found");
          const body = await readJsonBody<AgentDefinition>(req);
          await cli.writeAgent(id, body);
          sendJson(res, 200, { ok: true });
        });
        return;
      }
      if (method === "DELETE") {
        guard(async () => {
          if (id === undefined) throw new CliError("not found");
          await cli.removeAgent(id);
          sendJson(res, 200, { ok: true });
        });
        return;
      }
    }

    sendJson(res, 404, { error: "not found" });
  };
}

/** Decode one path segment; a malformed %-escape → undefined (→ 404). */
function decodeIdSafe(seg: string): string | undefined {
  try {
    return decodeURIComponent(seg);
  } catch {
    return undefined;
  }
}
