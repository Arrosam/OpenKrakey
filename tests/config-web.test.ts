/**
 * Black-box EDGE tests for the NEW `config-web` node (packages/config-web/) — a
 * standalone, loopback web config tool that reads/writes the same on-disk config
 * surface as the `cli` (agents/, the Default Setting, the LLM catalogue) and serves
 * a single-page UI plus a small token-gated JSON API.
 *
 * Surface under test is derived ONLY from the module signatures handed to this
 * test-writer + the shared contracts it composes (contracts/agent, shared/config,
 * shared/config-ops, contracts/plugin). NO implementation was read — packages/
 * does not exist yet, so:
 *   - schema-loader / server imports are GUARDED dynamic imports: a missing module
 *     turns RED on a clean assertion (`not implemented yet`), never an import crash.
 *
 * HTTP style mirrors tests/http-auth.test.ts + the loopback servers in
 * tests/plugins/{web,inspector}: bind 127.0.0.1 on an ephemeral port (port 0),
 * read the real port off the returned handle, authenticate via the `?token=` query
 * param, and ALWAYS close the server in a `finally` so a failing assertion can
 * never wedge the suite on an open listener.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Resolve the REAL repo `public_plugin/` relative to THIS test file (tests/),
// so the schema-loader tests run against the actual shipped plugin set rather
// than a fixture (the spec pins the exact 8 plugin ids it must surface).
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const PUBLIC_PLUGIN_DIR = resolve(REPO, "public_plugin");

// ---------------------------------------------------------------------------
// Guarded dynamic imports of the not-yet-existing modules. A missing module
// yields `{}` so each test fails on an honest assertion, not an import throw.
// ---------------------------------------------------------------------------
const schemaMod: any = await import("../packages/config-web/src/schema-loader").catch(() => ({}));
const serverMod: any = await import("../packages/config-web/src/server").catch(() => ({}));

/** Every public plugin id the config UI must surface a schema for. */
const REQUIRED_PLUGIN_IDS = [
  "persona",
  "system-prompt",
  "llm-core",
  "web",
  "inspector",
  "krakeycode",
  "searxng",
  "browser",
] as const;

// A token long enough to be a realistic session secret (matches the >=16 the
// loopback servers mint, and exercises a constant-time compare).
const TOKEN = "test-token-1234567890abcdef";
const HOST = "127.0.0.1";

// ===========================================================================
// A. assembleSchema — pure schema assembly from the real public_plugin/ dir
// ===========================================================================

test("assembleSchema: returns pluginSchemas for ALL 8 shipped plugins, each a non-empty ConfigField[]", async () => {
  assert.equal(
    typeof schemaMod.assembleSchema,
    "function",
    "schema-loader.assembleSchema not implemented yet",
  );

  const payload = await schemaMod.assembleSchema({ publicPluginDir: PUBLIC_PLUGIN_DIR });
  assert.ok(payload && typeof payload === "object", "assembleSchema must return a SchemaPayload object");

  const schemas = payload.pluginSchemas;
  assert.ok(schemas && typeof schemas === "object", "payload.pluginSchemas must be an object map");

  for (const id of REQUIRED_PLUGIN_IDS) {
    const fields = schemas[id];
    assert.ok(Array.isArray(fields), `pluginSchemas['${id}'] must be an array of ConfigField`);
    assert.ok(fields.length > 0, `pluginSchemas['${id}'] must be non-empty`);
    for (const [i, f] of fields.entries()) {
      assert.ok(f && typeof f === "object", `${id}[${i}] must be an object`);
      assert.equal(typeof f.key, "string", `${id}[${i}].key must be a string`);
      assert.ok(f.key.length > 0, `${id}[${i}].key must be non-empty`);
      assert.equal(typeof f.label, "string", `${id}[${i}] (${f.key}).label must be a string`);
      assert.equal(typeof f.type, "string", `${id}[${i}] (${f.key}).type must be a string`);
      assert.ok(f.type.length > 0, `${id}[${i}] (${f.key}).type must be non-empty`);
    }
  }
});

test("assembleSchema: providers is a non-empty array (the gateway's KNOWN_PROVIDERS)", async () => {
  assert.equal(typeof schemaMod.assembleSchema, "function", "assembleSchema not implemented yet");
  const payload = await schemaMod.assembleSchema({ publicPluginDir: PUBLIC_PLUGIN_DIR });
  assert.ok(Array.isArray(payload.providers), "payload.providers must be an array");
  assert.ok(payload.providers.length > 0, "payload.providers must be non-empty (KNOWN_PROVIDERS)");
});

test("assembleSchema: agentFields covers intervalMs/plugins/privatePlugins", async () => {
  assert.equal(typeof schemaMod.assembleSchema, "function", "assembleSchema not implemented yet");
  const payload = await schemaMod.assembleSchema({ publicPluginDir: PUBLIC_PLUGIN_DIR });
  assert.ok(Array.isArray(payload.agentFields), "payload.agentFields must be an array");
  assert.ok(payload.agentFields.length > 0, "payload.agentFields must be non-empty");
  const keys = new Set(payload.agentFields.map((f: any) => f.key));
  for (const k of ["intervalMs", "plugins", "privatePlugins"]) {
    assert.ok(keys.has(k), `agentFields must declare a '${k}' field; got ${JSON.stringify([...keys])}`);
  }
});

test("assembleSchema: capabilityLabels and modalityLabels are string maps", async () => {
  assert.equal(typeof schemaMod.assembleSchema, "function", "assembleSchema not implemented yet");
  const payload = await schemaMod.assembleSchema({ publicPluginDir: PUBLIC_PLUGIN_DIR });
  for (const which of ["capabilityLabels", "modalityLabels"] as const) {
    const map = payload[which];
    assert.ok(map && typeof map === "object" && !Array.isArray(map), `${which} must be a Record<string,string>`);
    for (const [k, v] of Object.entries(map)) {
      assert.equal(typeof k, "string", `${which} key must be a string`);
      assert.equal(typeof v, "string", `${which}['${k}'] must be a string label`);
    }
  }
});

test("assembleSchema: plugins is metadata listing AT LEAST the 8 required ids (with name?)", async () => {
  assert.equal(typeof schemaMod.assembleSchema, "function", "assembleSchema not implemented yet");
  const payload = await schemaMod.assembleSchema({ publicPluginDir: PUBLIC_PLUGIN_DIR });
  assert.ok(Array.isArray(payload.plugins), "payload.plugins must be an array");
  const ids = new Set(payload.plugins.map((p: any) => p && p.id));
  for (const id of REQUIRED_PLUGIN_IDS) {
    assert.ok(ids.has(id), `payload.plugins must include { id: '${id}' }`);
  }
  for (const [i, p] of payload.plugins.entries()) {
    assert.equal(typeof p.id, "string", `plugins[${i}].id must be a string`);
    if (p.name !== undefined) {
      assert.equal(typeof p.name, "string", `plugins[${i}].name, when present, must be a string`);
    }
  }
});

test("assembleSchema: a bare subdir with no index entry is NOT surfaced as a plugin", async () => {
  assert.equal(typeof schemaMod.assembleSchema, "function", "assembleSchema not implemented yet");
  // A throwaway public_plugin dir: one real plugin (index + schema) and one bare
  // data dir (no index.ts) — the loader can't load the bare one, so the config UI
  // must not offer it.
  const root = await mkdtemp(join(tmpdir(), "cw-pp-"));
  try {
    await mkdir(join(root, "realplug"), { recursive: true });
    await writeFile(join(root, "realplug", "index.ts"), "export {};");
    await writeFile(
      join(root, "realplug", "config-schema.ts"),
      'import type { ConfigSchema } from "../../contracts/plugin";\nexport const REALPLUG_SCHEMA: ConfigSchema = [{ key: "x", label: "X", type: "number", default: 1 }];\n',
    );
    await mkdir(join(root, "baredata", "data"), { recursive: true }); // no index.ts
    const payload = await schemaMod.assembleSchema({ publicPluginDir: root });
    const ids = new Set(payload.plugins.map((p: any) => p && p.id));
    assert.ok(ids.has("realplug"), "the real plugin must be surfaced");
    assert.equal(ids.has("baredata"), false, "a dir without an index entry must be excluded");
    assert.equal("baredata" in payload.pluginSchemas, false, "no schema for a non-plugin dir");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// B. server + API
// ---------------------------------------------------------------------------
// Each server test gets its OWN throwaway config dir (created fresh, removed in
// finally) so the tests are independent and order-free. The server binds an
// ephemeral port; we read the real port/url off the returned handle.
// ===========================================================================

interface TempConfig {
  dir: string;
  agentsDir: string;
  defaultPath: string;
  llmPath: string;
  cleanup(): Promise<void>;
}

/** Lay out a temp config dir with one known agent + default + llm catalogue. */
async function makeTempConfig(): Promise<TempConfig> {
  const dir = await mkdtemp(join(tmpdir(), "krakey-config-web-"));
  const agentsDir = join(dir, "agents");
  const configDir = join(dir, "config");
  const defaultPath = join(configDir, "agent.default.json");
  const llmPath = join(configDir, "llm.json");

  await mkdir(join(agentsDir, "krakey"), { recursive: true });
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(agentsDir, "krakey", "config.json"),
    JSON.stringify({ id: "krakey", intervalMs: 30000, plugins: ["persona"] }, null, 2),
  );
  await writeFile(defaultPath, JSON.stringify({ intervalMs: 1000, plugins: [] }, null, 2));
  await writeFile(llmPath, JSON.stringify({ communicators: {} }, null, 2));

  return {
    dir,
    agentsDir,
    defaultPath,
    llmPath,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

interface ServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Start the config-web server against `tc`, on an ephemeral loopback port. */
async function startServer(tc: TempConfig): Promise<ServerHandle> {
  assert.equal(
    typeof serverMod.startServer,
    "function",
    "server.startServer not implemented yet",
  );
  const handle = await serverMod.startServer({
    port: 0,
    host: HOST,
    token: TOKEN,
    agentsDir: tc.agentsDir,
    defaultPath: tc.defaultPath,
    publicPluginDir: PUBLIC_PLUGIN_DIR,
    llmPath: tc.llmPath,
  });
  assert.ok(handle && typeof handle === "object", "startServer must resolve a handle");
  assert.equal(typeof handle.port, "number", "handle.port must be a number");
  assert.ok(handle.port > 0, "an ephemeral port must be bound (got " + handle.port + ")");
  assert.equal(typeof handle.close, "function", "handle.close must be a function");
  return handle as ServerHandle;
}

const base = (h: ServerHandle) => "http://" + HOST + ":" + h.port;

/** Build a URL carrying the session token (authed requests). */
function api(h: ServerHandle, path: string, token: string = TOKEN): string {
  const sep = path.includes("?") ? "&" : "?";
  return base(h) + path + sep + "token=" + encodeURIComponent(token);
}

/**
 * Run `body(handle)` against a freshly started server, guaranteeing BOTH the
 * server and the temp config dir are torn down even when an assertion throws.
 */
async function withServer(body: (h: ServerHandle, tc: TempConfig) => Promise<void>): Promise<void> {
  const tc = await makeTempConfig();
  let h: ServerHandle | undefined;
  try {
    h = await startServer(tc);
    await body(h, tc);
  } finally {
    if (h) {
      try {
        await h.close();
      } catch {
        /* best-effort */
      }
    }
    await tc.cleanup();
  }
}

// --- B0: handle shape — url is loopback and reflects the bound port ---------
test("server: the returned handle exposes a loopback URL containing the bound port", async () => {
  await withServer(async (h) => {
    assert.match(h.url, /127\.0\.0\.1/, "the server binds loopback (URL is 127.0.0.1)");
    assert.match(h.url, new RegExp(":" + h.port + "\\b"), "the URL carries the bound port");
  });
});

// --- B1: GET / serves the SPA shell (no token required) --------------------
test("server: GET / serves an HTML SPA shell with 200 + text/html", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/, "GET / must be HTML");
    const html = await res.text();
    assert.match(html, /<\/html>|<!doctype|<div|<script/i, "the page must look like HTML");
  });
});

// --- B2: auth — tokenless API request is 401 -------------------------------
test("server: GET /api/agents WITHOUT a token -> 401", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/api/agents");
    assert.equal(res.status, 401, "the API must be token-gated");
  });
});

test("server: GET /api/agents with a WRONG token -> 401", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/agents", "not-the-real-token"));
    assert.equal(res.status, 401, "a bad token must be rejected");
  });
});

// --- B3: GET /api/agents lists agent ids -----------------------------------
test("server: GET /api/agents?token -> 200 { agents: ['krakey'] }", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/agents"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { agents: string[] };
    assert.ok(Array.isArray(body.agents), "body.agents must be an array");
    assert.deepEqual(body.agents, ["krakey"], "the one configured agent is listed");
  });
});

// --- B4: GET /api/agents/:id reads one AgentDefinition ----------------------
test("server: GET /api/agents/krakey?token -> 200 the AgentDefinition", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/agents/krakey"));
    assert.equal(res.status, 200);
    const def = (await res.json()) as { id: string; intervalMs: number; plugins: string[] };
    assert.equal(def.id, "krakey", "the agent id round-trips");
    assert.equal(def.intervalMs, 30000, "the stored intervalMs is returned");
    assert.deepEqual(def.plugins, ["persona"], "the stored plugin list is returned");
  });
});

// --- B5: GET a missing agent -> 404 ----------------------------------------
test("server: GET /api/agents/missing?token -> 404", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/agents/missing"));
    assert.equal(res.status, 404, "an unknown agent id is 404, not 200/500");
  });
});

// --- B6: PUT an agent persists; a follow-up GET reflects the change ---------
test("server: PUT /api/agents/krakey?token persists; a subsequent GET reflects it (state transition)", async () => {
  await withServer(async (h, tc) => {
    const updated = { id: "krakey", intervalMs: 5000, plugins: ["persona", "web"] };
    const put = await fetch(api(h, "/api/agents/krakey"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(updated),
    });
    assert.equal(put.status, 200, "a valid PUT is accepted");

    // The change is reflected over the API...
    const get = await fetch(api(h, "/api/agents/krakey"));
    assert.equal(get.status, 200);
    const def = (await get.json()) as { intervalMs: number; plugins: string[] };
    assert.equal(def.intervalMs, 5000, "the new intervalMs is read back");
    assert.deepEqual(def.plugins, ["persona", "web"], "the new plugin list is read back");

    // ...and PERSISTED to disk (the file the cli would also read).
    const onDisk = JSON.parse(
      await readFile(join(tc.agentsDir, "krakey", "config.json"), "utf8"),
    ) as { intervalMs: number };
    assert.equal(onDisk.intervalMs, 5000, "the change is written to the agent's config.json on disk");
  });
});

// --- B7: GET /api/default reads the Default Setting -------------------------
test("server: GET /api/default?token -> 200 the Default Setting", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/default"));
    assert.equal(res.status, 200);
    const setting = (await res.json()) as { intervalMs: number; plugins: string[] };
    assert.equal(setting.intervalMs, 1000, "the stored default intervalMs is returned");
    assert.deepEqual(setting.plugins, [], "the stored default plugin list is returned");
  });
});

// --- B8: GET /api/llm reads the LLM catalogue ------------------------------
test("server: GET /api/llm?token -> 200 { communicators: {} }", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/llm"));
    assert.equal(res.status, 200);
    const cfg = (await res.json()) as { communicators: Record<string, unknown> };
    assert.ok(cfg.communicators && typeof cfg.communicators === "object", "communicators map present");
    assert.deepEqual(cfg.communicators, {}, "the empty catalogue round-trips");
  });
});

// --- B9: GET /api/schema serves the assembled schema -----------------------
test("server: GET /api/schema?token -> 200 with pluginSchemas for all 8 plugins", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/schema"));
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { pluginSchemas: Record<string, unknown[]> };
    assert.ok(payload.pluginSchemas && typeof payload.pluginSchemas === "object", "pluginSchemas present");
    for (const id of REQUIRED_PLUGIN_IDS) {
      assert.ok(Array.isArray(payload.pluginSchemas[id]), `schema for '${id}' is served`);
      assert.ok((payload.pluginSchemas[id] as unknown[]).length > 0, `schema for '${id}' is non-empty`);
    }
  });
});

// --- B10: GET /api/plugins lists the available public plugins --------------
test("server: GET /api/plugins?token -> 200 { plugins:[...] } including the 8 ids", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/plugins"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { plugins: unknown[] };
    assert.ok(Array.isArray(body.plugins), "body.plugins must be an array");
    // Normalize to ids whether entries are strings or { id } objects.
    const ids = new Set(
      body.plugins.map((p) => (typeof p === "string" ? p : (p as { id?: string })?.id)),
    );
    for (const id of REQUIRED_PLUGIN_IDS) {
      assert.ok(ids.has(id), `the plugin list must include '${id}' (from the real public_plugin dir)`);
    }
  });
});

// --- B11: corrupt config on disk -> 422 (file exists but is not JSON) -------
test("server: GET /api/llm with a CORRUPT llm.json on disk -> 422", async () => {
  await withServer(async (h, tc) => {
    // A healthy read first (proves the server is up + the path is right).
    const ok = await fetch(api(h, "/api/llm"));
    assert.equal(ok.status, 200, "baseline read of valid llm.json is 200");

    // Corrupt the file on disk, then re-read: present-but-invalid → 422.
    await writeFile(tc.llmPath, "{ not json");
    const res = await fetch(api(h, "/api/llm"));
    assert.equal(
      res.status,
      422,
      "a file that EXISTS but holds invalid JSON is 422 (Unprocessable), distinct from a 404 absence",
    );
  });
});

// --- B12: malformed request body on a write -> 400 -------------------------
test("server: PUT /api/default?token with a non-JSON body -> 400", async () => {
  await withServer(async (h) => {
    const res = await fetch(api(h, "/api/default"), {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    assert.equal(res.status, 400, "an unparseable request body is a 400 Bad Request");
  });
});

// --- B13: token may also be omitted on the non-API SPA shell ---------------
test("server: GET / serves the shell WITHOUT a token (the page holds no secrets)", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/");
    assert.equal(res.status, 200, "the SPA shell itself is not token-gated");
  });
});
