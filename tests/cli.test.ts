/**
 * Black-box edge tests for the `cli` node's PURE file-ops core (`createCli`).
 *
 * Scope: ONLY the testable, inquirer-free file-ops surface exposed by
 * `createCli(deps)` — the interactive @inquirer/prompts pages are NOT tested here.
 *
 * What's contract-pinned (and therefore asserted):
 *   - AgentDefinition  = { id, intervalMs, plugins: string[], privatePlugins?, config? }
 *     (contracts/agent)
 *   - DefaultAgentSetting = { intervalMs, plugins, privatePlugins?, config? }  (no id)
 *   - LLMConfig = { communicators: Record<string, CommunicatorDef>, default? }
 *     (shared/config)
 *
 * Behavior pinned by the cli node overview (overviews/nodes/cli.md):
 *   - listAgents / readAgent / createAgent (copy default; refuse if exists) /
 *     writeAgent / removeAgent (delete config only, keep data) / readDefault /
 *     writeDefault / listAvailablePlugins (dirs under public_plugin/) /
 *     readLLMConfig / writeLLMConfig / listCommunicators.
 *   - `CliError` = user-facing validation surface (the cases the TUI catches+prints).
 *
 * Isolation: every test gets a brand-new OS temp dir (created in beforeEach,
 * removed in afterEach), and all four dep paths are ABSOLUTE paths under it.
 * Nothing here touches the network, other nodes, or the real filesystem layout.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as cliModule from "../packages/cli/src";
import { KNOWN_PROVIDERS, CAPABILITY_LABELS, MODALITY_LABELS } from "../shared/config";
import { createCommunicatorLibrary } from "../packages/llm-gateway/src";
const { createCli, CliError } = cliModule;
/**
 * `CliParseError` is a CONTRACT ADDITION not yet implemented. We resolve it at
 * runtime (instead of a static named import) so this whole test file still LOADS
 * — otherwise a missing named export would crash the harness and mask every
 * other test. Until the impl exports it, this falls back to a private sentinel
 * class that NO real thrown error can ever be an instanceof, so the
 * `instanceof CliParseError` assertions fail honestly (red), not on import.
 */
const CliParseError: any =
  (cliModule as any).CliParseError ??
  class __MissingCliParseError__ extends (CliError as any) {};
import type { AgentDefinition } from "../contracts/agent";
import type { DefaultAgentSetting, LLMConfig } from "../shared/config";

// ---------------------------------------------------------------------------
// per-test temp sandbox + dep paths (all ABSOLUTE)
// ---------------------------------------------------------------------------

let tmp: string;
let agentsDir: string;
let defaultPath: string;
let publicPluginDir: string;
let llmPath: string;
/** Lines captured from the optional `out` sink (so tests never spam stdout). */
let outLines: string[];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-"));
  agentsDir = path.join(tmp, "agents");
  defaultPath = path.join(tmp, "config", "agent.default.json");
  publicPluginDir = path.join(tmp, "public_plugin");
  llmPath = path.join(tmp, "config", "llm.json");
  outLines = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Build a Cli wired to this test's sandbox. `out` is captured, not printed. */
function makeCli() {
  return createCli({
    agentsDir,
    defaultPath,
    publicPluginDir,
    llmPath,
    out: (m: string) => outLines.push(m),
  });
}

/** A representative DefaultAgentSetting (the thing /new copies from). */
function sampleDefault(over: Partial<DefaultAgentSetting> = {}): DefaultAgentSetting {
  return {
    intervalMs: 5000,
    plugins: [],
    privatePlugins: [],
    config: {},
    ...over,
  };
}

/** mkdir -p, then write a sentinel file (proves a dir is left intact). */
function touch(file: string, body = "sentinel"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

/** Read the on-disk agent config file directly (bypassing the Cli). */
function rawAgentConfig(id: string): any {
  return JSON.parse(fs.readFileSync(path.join(agentsDir, id, "config.json"), "utf8"));
}

// ===========================================================================
// 1. readDefault() — absent file rejects with CliError
// ===========================================================================

test("readDefault: rejects with CliError when the default file is absent", async () => {
  const cli = makeCli();
  await assert.rejects(cli.readDefault(), CliError);
});

test("readDefault: rejects with CliError even when config/ dir exists but file does not", async () => {
  // Create the directory but NOT the file — still a missing default.
  fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
  const cli = makeCli();
  await assert.rejects(cli.readDefault(), CliError);
});

// ===========================================================================
// 2. writeDefault() then readDefault() round-trips; creates config/ as needed
// ===========================================================================

test("writeDefault -> readDefault: round-trips the setting object", async () => {
  const cli = makeCli();
  const setting = sampleDefault();
  await cli.writeDefault(setting);
  const got = await cli.readDefault();
  assert.deepEqual(got, setting);
});

test("writeDefault: creates the config/ directory when it is missing", async () => {
  // Precondition: parent dir does NOT exist yet.
  assert.equal(fs.existsSync(path.dirname(defaultPath)), false);
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  assert.equal(fs.existsSync(defaultPath), true, "default file must have been written");
  assert.equal(
    fs.statSync(path.dirname(defaultPath)).isDirectory(),
    true,
    "config/ must have been created",
  );
});

test("writeDefault -> readDefault: round-trips a richly-populated setting", async () => {
  const cli = makeCli();
  const setting = sampleDefault({
    intervalMs: 1,
    plugins: ["weather", "memory"],
    privatePlugins: ["journal"],
    config: { weather: { city: "Oslo" }, persona: { name: "K" } },
  });
  await cli.writeDefault(setting);
  assert.deepEqual(await cli.readDefault(), setting);
});

test("writeDefault: a second write overwrites the first (last-writer-wins)", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 1000 }));
  await cli.writeDefault(sampleDefault({ intervalMs: 9000 }));
  const got = await cli.readDefault();
  assert.equal(got.intervalMs, 9000);
});

test("writeDefault: round-trips an omitted-optionals setting (only required fields)", async () => {
  const cli = makeCli();
  // DefaultAgentSetting requires only intervalMs + plugins.
  const minimal: DefaultAgentSetting = { intervalMs: 2500, plugins: [] };
  await cli.writeDefault(minimal);
  const got = await cli.readDefault();
  assert.equal(got.intervalMs, 2500);
  assert.deepEqual(got.plugins, []);
});

test("writeDefault: persists across a fresh Cli instance over the same paths", async () => {
  await makeCli().writeDefault(sampleDefault({ intervalMs: 7777 }));
  // A brand new Cli pointed at the same files must observe the write.
  const got = await makeCli().readDefault();
  assert.equal(got.intervalMs, 7777);
});

// ===========================================================================
// 3. createAgent() — no default present rejects with CliError
// ===========================================================================

test("createAgent: rejects with CliError when no default exists", async () => {
  const cli = makeCli();
  await assert.rejects(cli.createAgent("alice"), CliError);
});

test("createAgent: rejection message mentions the missing default", async () => {
  const cli = makeCli();
  await assert.rejects(cli.createAgent("alice"), (err: unknown) => {
    assert.ok(err instanceof CliError, "must be a CliError");
    assert.match(
      (err as Error).message,
      /default/i,
      "message should point at the missing default",
    );
    return true;
  });
});

test("createAgent: with no default, does NOT create the agent dir/config", async () => {
  const cli = makeCli();
  await assert.rejects(cli.createAgent("alice"), CliError);
  assert.equal(
    fs.existsSync(path.join(agentsDir, "alice", "config.json")),
    false,
    "no config file may be written when creation fails",
  );
});

// ===========================================================================
// 4. createAgent() seeds from default; listAgents/readAgent observe it
// ===========================================================================

test("createAgent: writes agents/<id>/config.json seeded from the default with id set", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 5000, plugins: ["weather"] }));
  await cli.createAgent("alice");

  // File exists at the contract-pinned location.
  const file = path.join(agentsDir, "alice", "config.json");
  assert.equal(fs.existsSync(file), true, "config.json must exist at agents/alice/");

  // Content is seeded from the default AND carries id:"alice".
  const def = await cli.readAgent("alice");
  assert.equal(def.id, "alice");
  assert.equal(def.intervalMs, 5000);
  assert.deepEqual(def.plugins, ["weather"]);
});

test("createAgent: the persisted file carries id:'alice' (verified by raw read)", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  const onDisk = rawAgentConfig("alice");
  assert.equal(onDisk.id, "alice");
});

test("createAgent -> listAgents: the new id appears in the listing", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  const ids = await cli.listAgents();
  assert.ok(Array.isArray(ids), "listAgents must return an array");
  assert.ok(ids.includes("alice"), `listing must include 'alice', got: ${JSON.stringify(ids)}`);
});

test("createAgent -> readAgent: returns a definition matching the AgentDefinition shape", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 1234, plugins: ["a"], privatePlugins: ["b"] }));
  await cli.createAgent("alice");
  const def: AgentDefinition = await cli.readAgent("alice");
  assert.equal(def.id, "alice");
  assert.equal(typeof def.intervalMs, "number");
  assert.ok(Array.isArray(def.plugins), "plugins must be an array");
  assert.equal(def.intervalMs, 1234);
  assert.deepEqual(def.plugins, ["a"]);
  assert.deepEqual(def.privatePlugins, ["b"]);
});

test("createAgent: changes to the default after creation do NOT mutate an existing agent", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 1000 }));
  await cli.createAgent("alice");
  // Mutate the default afterwards.
  await cli.writeDefault(sampleDefault({ intervalMs: 9999 }));
  const def = await cli.readAgent("alice");
  assert.equal(def.intervalMs, 1000, "existing agent keeps its seeded value (a copy, not a live link)");
});

test("createAgent: distinct ids produce independent files both listed", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  await cli.createAgent("bob");
  const ids = await cli.listAgents();
  assert.ok(ids.includes("alice") && ids.includes("bob"));
  assert.equal((await cli.readAgent("alice")).id, "alice");
  assert.equal((await cli.readAgent("bob")).id, "bob");
});

// ===========================================================================
// 5. createAgent() on an existing id — refuse, no overwrite
// ===========================================================================

test("createAgent: rejects with CliError when the agent already exists", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  await assert.rejects(cli.createAgent("alice"), CliError);
});

test("createAgent: a refused duplicate leaves the existing config file BYTE-for-BYTE unchanged", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 1000, plugins: ["x"] }));
  await cli.createAgent("alice");

  const file = path.join(agentsDir, "alice", "config.json");
  const before = fs.readFileSync(file, "utf8");

  // Change the default so a (wrongful) overwrite would be detectable...
  await cli.writeDefault(sampleDefault({ intervalMs: 9999, plugins: ["y", "z"] }));
  await assert.rejects(cli.createAgent("alice"), CliError);

  const after = fs.readFileSync(file, "utf8");
  assert.equal(after, before, "the duplicate create must NOT overwrite the existing config");
});

// ===========================================================================
// 6. readAgent() — absent id rejects with CliError
// ===========================================================================

test("readAgent: rejects with CliError for an absent id", async () => {
  const cli = makeCli();
  await assert.rejects(cli.readAgent("ghost"), CliError);
});

test("readAgent: rejects with CliError for an absent id even when other agents exist", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  await assert.rejects(cli.readAgent("ghost"), CliError);
});

// ===========================================================================
// 7. writeAgent() then readAgent() round-trips
// ===========================================================================

test("writeAgent -> readAgent: round-trips a full AgentDefinition", async () => {
  const cli = makeCli();
  const def: AgentDefinition = {
    id: "carol",
    intervalMs: 3000,
    plugins: ["weather", "news"],
    privatePlugins: ["diary"],
    config: { weather: { units: "metric" } },
  };
  await cli.writeAgent("carol", def);
  const got = await cli.readAgent("carol");
  assert.deepEqual(got, def);
});

test("writeAgent: does not require a default to exist", async () => {
  const cli = makeCli();
  // No writeDefault() here on purpose.
  const def: AgentDefinition = { id: "dave", intervalMs: 100, plugins: [] };
  await cli.writeAgent("dave", def);
  assert.equal((await cli.readAgent("dave")).id, "dave");
});

test("writeAgent: creates agents/<id>/ and lists the id", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(agentsDir), false, "agents dir absent before writeAgent");
  await cli.writeAgent("erin", { id: "erin", intervalMs: 500, plugins: [] });
  assert.ok((await cli.listAgents()).includes("erin"));
});

test("writeAgent: a second write to the same id overwrites (round-trips the new value)", async () => {
  const cli = makeCli();
  await cli.writeAgent("frank", { id: "frank", intervalMs: 100, plugins: [] });
  await cli.writeAgent("frank", { id: "frank", intervalMs: 200, plugins: ["p"] });
  const got = await cli.readAgent("frank");
  assert.equal(got.intervalMs, 200);
  assert.deepEqual(got.plugins, ["p"]);
});

test("writeAgent: round-trips a minimal definition (no optionals)", async () => {
  const cli = makeCli();
  const def: AgentDefinition = { id: "min", intervalMs: 42, plugins: [] };
  await cli.writeAgent("min", def);
  assert.deepEqual(await cli.readAgent("min"), def);
});

// ===========================================================================
// 8. removeAgent() — deletes the CONFIG FILE, keeps the agent directory + data
// ===========================================================================

test("removeAgent: deletes config.json but LEAVES agents/<id>/ and its data", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");

  // Drop a sentinel data file under the agent dir.
  const sentinel = path.join(agentsDir, "alice", "data", "x");
  touch(sentinel, "keep-me");

  const config = path.join(agentsDir, "alice", "config.json");
  assert.equal(fs.existsSync(config), true, "precondition: config exists");

  await cli.removeAgent("alice");

  assert.equal(fs.existsSync(config), false, "config.json must be deleted");
  assert.equal(fs.existsSync(sentinel), true, "the agent's data file must be preserved");
  assert.equal(
    fs.existsSync(path.join(agentsDir, "alice")),
    true,
    "the agents/alice/ directory must remain",
  );
});

test("removeAgent -> listAgents: after removal the id is gone from the listing", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  await cli.createAgent("bob");
  await cli.removeAgent("alice");
  const ids = await cli.listAgents();
  assert.equal(ids.includes("alice"), false, "removed id must not be listed");
  assert.ok(ids.includes("bob"), "untouched agent must still be listed");
});

test("removeAgent -> readAgent: reading the removed id then rejects with CliError", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("alice");
  await cli.removeAgent("alice");
  await assert.rejects(cli.readAgent("alice"), CliError);
});

test("removeAgent: an id can be re-created after removal (state transition full cycle)", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 1000 }));
  await cli.createAgent("alice");
  await cli.removeAgent("alice");
  // create -> remove -> create again must succeed (no lingering "exists" guard).
  await cli.createAgent("alice");
  assert.equal((await cli.readAgent("alice")).id, "alice");
});

// ===========================================================================
// 9. listAgents() — empty/missing dir => []; sorted with multiple
// ===========================================================================

test("listAgents: returns [] when the agents directory does not exist", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(agentsDir), false, "agents dir must be absent");
  assert.deepEqual(await cli.listAgents(), []);
});

test("listAgents: returns [] when the agents directory exists but is empty", async () => {
  fs.mkdirSync(agentsDir, { recursive: true });
  const cli = makeCli();
  assert.deepEqual(await cli.listAgents(), []);
});

test("listAgents: a single created agent yields a one-element listing", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  await cli.createAgent("solo");
  assert.deepEqual(await cli.listAgents(), ["solo"]);
});

test("listAgents: multiple agents are returned in sorted order", async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  // Create out of alphabetical order.
  await cli.createAgent("charlie");
  await cli.createAgent("alice");
  await cli.createAgent("bob");
  assert.deepEqual(await cli.listAgents(), ["alice", "bob", "charlie"]);
});

// ===========================================================================
// 10. listAvailablePlugins() — subdirs under public_plugin/ that hold an
//     index.ts/index.js entry (i.e. real, loadable plugins); missing => []
// ===========================================================================

/** Make `<publicPluginDir>/<id>/` look like a real plugin (has an entry point). */
function makePlugin(id: string): void {
  fs.mkdirSync(path.join(publicPluginDir, id), { recursive: true });
  fs.writeFileSync(path.join(publicPluginDir, id, "index.ts"), "export {};", "utf8");
}

test("listAvailablePlugins: returns [] when public_plugin/ does not exist", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(publicPluginDir), false, "public_plugin dir must be absent");
  assert.deepEqual(await cli.listAvailablePlugins(), []);
});

test("listAvailablePlugins: returns [] when public_plugin/ exists but is empty", async () => {
  fs.mkdirSync(publicPluginDir, { recursive: true });
  const cli = makeCli();
  assert.deepEqual(await cli.listAvailablePlugins(), []);
});

test("listAvailablePlugins: returns the subdirectory names (sorted)", async () => {
  makePlugin("weather");
  makePlugin("memory");
  const cli = makeCli();
  const got = await cli.listAvailablePlugins();
  assert.deepEqual([...got].sort(), ["memory", "weather"]);
});

test("listAvailablePlugins: ignores plain files at the top of public_plugin/", async () => {
  fs.mkdirSync(publicPluginDir, { recursive: true });
  makePlugin("realplugin");
  // A stray file (e.g. README) must NOT be reported as a plugin.
  fs.writeFileSync(path.join(publicPluginDir, "README.md"), "# plugins", "utf8");
  const cli = makeCli();
  const got = await cli.listAvailablePlugins();
  assert.equal(got.includes("realplugin"), true, "the directory must be listed");
  assert.equal(got.includes("README.md"), false, "a file must not be listed as a plugin");
});

test("listAvailablePlugins: excludes a subdir with no index entry (a bare data dir)", async () => {
  makePlugin("realplugin");
  // A bare directory (e.g. a data-only dir like notes/) with no index.ts/.js is
  // NOT a loadable plugin and must not be offered as one.
  fs.mkdirSync(path.join(publicPluginDir, "notesy", "data"), { recursive: true });
  const cli = makeCli();
  const got = await cli.listAvailablePlugins();
  assert.equal(got.includes("realplugin"), true, "a real plugin must be listed");
  assert.equal(got.includes("notesy"), false, "a dir without an index entry must be excluded");
});

// ===========================================================================
// 11. LLM config — absent default; round-trip; listCommunicators
// ===========================================================================

test("readLLMConfig: returns { communicators: {} } when the file is absent", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(llmPath), false, "llm.json must be absent");
  const got = await cli.readLLMConfig();
  assert.deepEqual(got, { communicators: {} });
});

test("writeLLMConfig -> readLLMConfig: round-trips a single communicator", async () => {
  const cli = makeCli();
  const cfg: LLMConfig = {
    communicators: { claude: { provider: "anthropic", model: "m" } },
  };
  await cli.writeLLMConfig(cfg);
  assert.deepEqual(await cli.readLLMConfig(), cfg);
});

test("writeLLMConfig: creates config/ as needed and persists the file", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(path.dirname(llmPath)), false, "config/ absent beforehand");
  await cli.writeLLMConfig({ communicators: { claude: { provider: "anthropic", model: "m" } } });
  assert.equal(fs.existsSync(llmPath), true, "llm.json must have been written");
});

test("writeLLMConfig -> listCommunicators: returns ['claude'] for the single configured name", async () => {
  const cli = makeCli();
  await cli.writeLLMConfig({
    communicators: { claude: { provider: "anthropic", model: "m" } },
  });
  assert.deepEqual(await cli.listCommunicators(), ["claude"]);
});

test("listCommunicators: returns [] when no llm config file exists", async () => {
  const cli = makeCli();
  assert.deepEqual(await cli.listCommunicators(), []);
});

test("writeLLMConfig -> listCommunicators: multiple communicators returned sorted", async () => {
  const cli = makeCli();
  await cli.writeLLMConfig({
    communicators: {
      zeta: { provider: "openai-completion", model: "gpt-4o" },
      alpha: { provider: "anthropic", model: "claude-x" },
    },
  });
  assert.deepEqual(await cli.listCommunicators(), ["alpha", "zeta"]);
});

test("writeLLMConfig -> readLLMConfig: round-trips a full CommunicatorDef + default field", async () => {
  const cli = makeCli();
  const cfg: LLMConfig = {
    communicators: {
      claude: {
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        apiKey: "${ANTHROPIC_KEY}",
        baseURL: "https://api.anthropic.com",
        temperature: 0.7,
        maxTokens: 1024,
      },
    },
    default: "claude",
  };
  await cli.writeLLMConfig(cfg);
  assert.deepEqual(await cli.readLLMConfig(), cfg);
});

test("writeLLMConfig: a second write overwrites the communicator catalogue", async () => {
  const cli = makeCli();
  await cli.writeLLMConfig({ communicators: { a: { provider: "anthropic", model: "m" } } });
  await cli.writeLLMConfig({ communicators: { b: { provider: "openai-completion", model: "n" } } });
  assert.deepEqual(await cli.listCommunicators(), ["b"]);
  const got = await cli.readLLMConfig();
  assert.equal("a" in got.communicators, false, "old communicator must be gone after overwrite");
});

test("writeLLMConfig: persists across a fresh Cli over the same llmPath", async () => {
  await makeCli().writeLLMConfig({
    communicators: { claude: { provider: "anthropic", model: "m" } },
  });
  const got = await makeCli().readLLMConfig();
  assert.deepEqual(got.communicators.claude, { provider: "anthropic", model: "m" });
});

test("readLLMConfig: round-trips an explicitly-empty communicators map", async () => {
  const cli = makeCli();
  await cli.writeLLMConfig({ communicators: {} });
  assert.deepEqual(await cli.readLLMConfig(), { communicators: {} });
  assert.deepEqual(await cli.listCommunicators(), []);
});

// ===========================================================================
// 12. CliParseError — a file that EXISTS but holds invalid JSON is a distinct,
//     recoverable error (corrupt) vs an ABSENT file (which keeps prior behavior).
//     Contract addition: CliParseError extends CliError.
// ===========================================================================

/** Write a deliberately-broken JSON body straight to disk (bypassing the Cli). */
function writeGarbage(file: string, body = "{ this is : not json,, ]"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}

// --- CliParseError must itself be a CliError subclass (so the TUI's CliError
//     catch keeps working) yet be distinguishable for "corrupt vs absent". ---

test("CliParseError: is exported by the cli module and subclasses CliError", () => {
  // Pin BOTH the export's existence and its class hierarchy. (Asserting on the
  // module export — not the runtime fallback — keeps this red until implemented.)
  const Exported = (cliModule as any).CliParseError;
  assert.equal(typeof Exported, "function", "cli module must export a CliParseError class");
  const e = new Exported("boom");
  assert.ok(e instanceof Exported, "must be a CliParseError");
  assert.ok(e instanceof CliError, "CliParseError must extend CliError");
  assert.ok(e instanceof Error, "and ultimately an Error");
});

// --- readDefault: invalid JSON => CliParseError; absent => CliError but NOT CliParseError ---

test("readDefault: invalid-JSON default file rejects with CliParseError (also a CliError)", async () => {
  writeGarbage(defaultPath);
  const cli = makeCli();
  await assert.rejects(cli.readDefault(), (err: unknown) => {
    assert.ok(err instanceof CliParseError, "corrupt default must be a CliParseError");
    assert.ok(err instanceof CliError, "CliParseError must also be a CliError");
    return true;
  });
});

test("readDefault: ABSENT default rejects with a CliError that is NOT a CliParseError", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(defaultPath), false, "precondition: default absent");
  await assert.rejects(cli.readDefault(), (err: unknown) => {
    assert.ok(err instanceof CliError, "absent default is still a CliError");
    assert.equal(
      err instanceof CliParseError,
      false,
      "absent (not corrupt) must NOT be flagged as a parse error",
    );
    return true;
  });
});

// --- readAgent: invalid JSON => CliParseError; absent => CliError but NOT CliParseError ---

test("readAgent: an agent config.json holding invalid JSON rejects with CliParseError", async () => {
  writeGarbage(path.join(agentsDir, "alice", "config.json"));
  const cli = makeCli();
  await assert.rejects(cli.readAgent("alice"), (err: unknown) => {
    assert.ok(err instanceof CliParseError, "corrupt agent config must be a CliParseError");
    assert.ok(err instanceof CliError, "and also a CliError");
    return true;
  });
});

test("readAgent: an ABSENT id rejects with a CliError that is NOT a CliParseError", async () => {
  const cli = makeCli();
  await assert.rejects(cli.readAgent("ghost"), (err: unknown) => {
    assert.ok(err instanceof CliError, "absent id is still a CliError ('not found')");
    assert.equal(
      err instanceof CliParseError,
      false,
      "a missing agent must not be reported as a parse error",
    );
    return true;
  });
});

// --- readLLMConfig: invalid JSON => CliParseError; absent => empty catalogue (no throw) ---

test("readLLMConfig: an llm.json holding invalid JSON rejects with CliParseError (also a CliError)", async () => {
  writeGarbage(llmPath);
  const cli = makeCli();
  await assert.rejects(cli.readLLMConfig(), (err: unknown) => {
    assert.ok(err instanceof CliParseError, "corrupt llm.json must be a CliParseError");
    assert.ok(err instanceof CliError, "and also a CliError");
    return true;
  });
});

test("readLLMConfig: an ABSENT llm.json keeps prior behavior — returns { communicators: {} }, never throws", async () => {
  const cli = makeCli();
  assert.equal(fs.existsSync(llmPath), false, "precondition: llm.json absent");
  // Absent must NOT be conflated with corrupt: the empty-catalogue contract stands.
  const got = await cli.readLLMConfig();
  assert.deepEqual(got, { communicators: {} });
});

test("listCommunicators: an llm.json holding invalid JSON rejects with CliParseError", async () => {
  // listCommunicators reads the same file; a corrupt catalogue must surface as parse error.
  writeGarbage(llmPath);
  const cli = makeCli();
  await assert.rejects(cli.listCommunicators(), (err: unknown) => {
    assert.ok(err instanceof CliParseError, "corrupt catalogue must be a CliParseError");
    assert.ok(err instanceof CliError, "and also a CliError");
    return true;
  });
});

// ===========================================================================
// 13. Id validation in the pure core — read/create/write/removeAgent reject the
//     dangerous ids "..", ".", "a/b", "a\\b", "" with CliError WITHOUT touching
//     the filesystem (no traversal escape, no create/overwrite/delete outside).
// ===========================================================================

/** The ids the pure core must reject before any fs access. */
const BAD_IDS = ["..", ".", "a/b", "a\\b", ""];

// --- readAgent rejects each bad id with CliError ---

for (const bad of BAD_IDS) {
  test(`readAgent: rejects dangerous id ${JSON.stringify(bad)} with CliError`, async () => {
    const cli = makeCli();
    await assert.rejects(cli.readAgent(bad), CliError);
  });
}

// --- createAgent rejects each bad id with CliError (even when a default exists) ---

for (const bad of BAD_IDS) {
  test(`createAgent: rejects dangerous id ${JSON.stringify(bad)} with CliError (default present)`, async () => {
    const cli = makeCli();
    await cli.writeDefault(sampleDefault());
    await assert.rejects(cli.createAgent(bad), CliError);
  });
}

// --- writeAgent rejects each bad id with CliError ---

for (const bad of BAD_IDS) {
  test(`writeAgent: rejects dangerous id ${JSON.stringify(bad)} with CliError`, async () => {
    const cli = makeCli();
    await assert.rejects(
      cli.writeAgent(bad, { id: bad, intervalMs: 100, plugins: [] }),
      CliError,
    );
  });
}

// --- removeAgent rejects each bad id with CliError ---

for (const bad of BAD_IDS) {
  test(`removeAgent: rejects dangerous id ${JSON.stringify(bad)} with CliError`, async () => {
    const cli = makeCli();
    await assert.rejects(cli.removeAgent(bad), CliError);
  });
}

// --- The decisive traversal assertions: ".." must never escape agentsDir. ---

test('createAgent(".."): does NOT create/overwrite anything outside agentsDir (sentinel one level up untouched)', async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault({ intervalMs: 4242, plugins: ["x"] }));

  // A sentinel sitting EXACTLY where agents/../config.json (== <tmp>/config.json)
  // would land if traversal were honored. It must survive byte-for-byte.
  const escapeTarget = path.join(path.dirname(agentsDir), "config.json");
  touch(escapeTarget, "DO-NOT-TOUCH");
  const before = fs.readFileSync(escapeTarget, "utf8");

  await assert.rejects(cli.createAgent(".."), CliError);

  assert.equal(
    fs.readFileSync(escapeTarget, "utf8"),
    before,
    'createAgent("..") must NOT write through the parent of agentsDir',
  );
  assert.equal(before, "DO-NOT-TOUCH", "sanity: sentinel body unchanged");
});

test('createAgent(".."): rejects BEFORE touching the filesystem — agentsDir stays absent if it was', async () => {
  const cli = makeCli();
  await cli.writeDefault(sampleDefault());
  // writeDefault touched config/ but NOT agents/. The rejected create must not
  // lazily materialize the agents dir either.
  const agentsExistedBefore = fs.existsSync(agentsDir);
  await assert.rejects(cli.createAgent(".."), CliError);
  assert.equal(
    fs.existsSync(agentsDir),
    agentsExistedBefore,
    'createAgent("..") must not create the agents directory as a side effect',
  );
});

test('removeAgent(".."): does NOT delete the sentinel one level above agentsDir', async () => {
  const cli = makeCli();

  // Same escape target as the create test; removeAgel must not unlink it.
  const escapeTarget = path.join(path.dirname(agentsDir), "config.json");
  touch(escapeTarget, "DO-NOT-DELETE");

  await assert.rejects(cli.removeAgent(".."), CliError);

  assert.equal(
    fs.existsSync(escapeTarget),
    true,
    'removeAgent("..") must NOT delete a file outside agentsDir',
  );
  assert.equal(
    fs.readFileSync(escapeTarget, "utf8"),
    "DO-NOT-DELETE",
    "and must leave its contents intact",
  );
});

test('writeAgent("a/b"): a slashed id does NOT create a nested file under agentsDir', async () => {
  const cli = makeCli();
  await assert.rejects(
    cli.writeAgent("a/b", { id: "a/b", intervalMs: 100, plugins: [] }),
    CliError,
  );
  // No "a/" subtree, no "a/b/config.json" must have appeared.
  assert.equal(
    fs.existsSync(path.join(agentsDir, "a", "b", "config.json")),
    false,
    "slashed id must not create a nested config path",
  );
  assert.equal(
    fs.existsSync(path.join(agentsDir, "a")),
    false,
    "no intermediate directory may be created for a slashed id",
  );
});

// ===========================================================================
// 14. createAgent id precedence — the REQUESTED id always wins, even when the
//     default-setting file maliciously/accidentally carries its own "id" field.
// ===========================================================================

test('createAgent: created config carries id === the REQUESTED id, NOT a stray "id" in the default', async () => {
  const cli = makeCli();
  // DefaultAgentSetting has no id in its type, but the on-disk file could still
  // contain one (hand-edited / malicious). It must be overridden by the request.
  await cli.writeDefault({
    intervalMs: 5000,
    plugins: ["weather"],
    // @ts-expect-error — deliberately stuffing an out-of-contract "id" into the default file.
    id: "evil-default-id",
  });

  await cli.createAgent("alice");

  // Via the Cli read...
  assert.equal((await cli.readAgent("alice")).id, "alice", "readAgent must report the requested id");
  // ...and via a raw on-disk read (no normalization could be hiding it).
  assert.equal(rawAgentConfig("alice").id, "alice", "persisted file must carry the requested id");
});

test('createAgent: a stray default "id" does not leak into a SECOND created agent either', async () => {
  const cli = makeCli();
  await cli.writeDefault({
    intervalMs: 1000,
    plugins: [],
    // @ts-expect-error — stray id in the default file.
    id: "evil-default-id",
  });
  await cli.createAgent("alice");
  await cli.createAgent("bob");
  assert.equal(rawAgentConfig("alice").id, "alice");
  assert.equal(rawAgentConfig("bob").id, "bob", "each created agent gets ITS OWN requested id");
});

// ===========================================================================
// 15. Provider catalogue (shared/config KNOWN_PROVIDERS) — the UI's drift-free
//     source for selects: ids, natural-language labels, capability/modality
//     vocab, and format guidance for every free field.
// ===========================================================================

const ALL_CAPS = ["chat", "embed", "rerank", "ocr"] as const;
const ALL_MODALITIES = ["text", "image", "audio", "video", "document"] as const;

test("KNOWN_PROVIDERS: exactly the five gateway adapter ids, no duplicates", () => {
  const ids = KNOWN_PROVIDERS.map((p) => p.id);
  assert.deepEqual(
    [...ids].sort(),
    ["anthropic", "cohere", "jina", "openai-completion", "openai-responses"],
    "the catalogue must list every adapter the gateway accepts — and nothing else",
  );
  assert.equal(new Set(ids).size, ids.length, "no duplicate provider ids");
});

test("KNOWN_PROVIDERS: every entry carries complete, natural-language UI guidance", () => {
  for (const p of KNOWN_PROVIDERS) {
    for (const field of ["label", "summary", "baseURLHint", "baseURLExample", "modelExample"] as const) {
      const v = (p as any)[field];
      assert.equal(typeof v, "string", `${p.id}.${field} must be a string`);
      assert.ok(v.trim().length > 0, `${p.id}.${field} must be non-empty`);
    }
    assert.notEqual(p.label, p.id, `${p.id}: label must be natural language, not the raw id`);
    assert.ok(p.capabilities.length > 0, `${p.id}: at least one capability`);
    for (const c of p.capabilities) {
      assert.ok((ALL_CAPS as readonly string[]).includes(c), `${p.id}: unknown capability '${c}'`);
    }
    assert.ok(p.defaultCapabilities.length > 0, `${p.id}: at least one default capability`);
    for (const c of p.defaultCapabilities) {
      assert.ok(p.capabilities.includes(c), `${p.id}: default capability '${c}' not in capabilities`);
    }
    assert.ok(p.inputs.length > 0, `${p.id}: at least one input modality`);
    for (const m of p.inputs) {
      assert.ok((ALL_MODALITIES as readonly string[]).includes(m), `${p.id}: unknown input '${m}'`);
    }
    assert.ok(p.outputs.length > 0, `${p.id}: at least one output modality`);
    for (const m of p.outputs) {
      assert.ok((ALL_MODALITIES as readonly string[]).includes(m), `${p.id}: unknown output '${m}'`);
    }
  }
});

test("capability/modality label maps: a natural-language label for every value", () => {
  for (const c of ALL_CAPS) {
    const label = CAPABILITY_LABELS[c];
    assert.equal(typeof label, "string", `missing capability label: ${c}`);
    assert.ok(label.trim().length > 0, `empty capability label: ${c}`);
    assert.notEqual(label, c, `capability label for '${c}' must be natural language, not the key`);
  }
  for (const m of ALL_MODALITIES) {
    const label = MODALITY_LABELS[m];
    assert.equal(typeof label, "string", `missing modality label: ${m}`);
    assert.ok(label.trim().length > 0, `empty modality label: ${m}`);
    assert.notEqual(label, m, `modality label for '${m}' must be natural language, not the key`);
  }
});

test("KNOWN_PROVIDERS × gateway cross-check: the table offers exactly what the gateway accepts (full 5×4 matrix, both directions)", () => {
  for (const p of KNOWN_PROVIDERS) {
    for (const cap of ALL_CAPS) {
      const lib = createCommunicatorLibrary(
        { communicators: { t: { provider: p.id, model: "m", apiKey: "k", capabilities: [cap] } } },
        { onError: () => {} },
      );
      const tableSays = p.capabilities.includes(cap);
      assert.equal(
        lib.has("t"),
        tableSays,
        `${p.id} + ${cap}: catalogue says ${tableSays ? "supported" : "unsupported"} but the gateway disagrees — UI choices have drifted from reality`,
      );
    }
  }
});

// ===========================================================================
// 16. normalizeBaseURL — the pure URL cleanup the providers UI applies on save
//     (kills the trailing-slash → `//chat/completions` failure class).
//     Resolved defensively: red on a missing export, never an import crash.
// ===========================================================================

const normalizeBaseURL: any = (cliModule as any).normalizeBaseURL;

test("normalizeBaseURL: exported as a function from the cli core", () => {
  assert.equal(typeof normalizeBaseURL, "function", "normalizeBaseURL not implemented yet");
});

test("normalizeBaseURL: strips one or many trailing slashes", () => {
  assert.equal(typeof normalizeBaseURL, "function", "normalizeBaseURL not implemented yet");
  assert.equal(normalizeBaseURL("http://x:1/"), "http://x:1");
  assert.equal(normalizeBaseURL("http://x:1///"), "http://x:1");
});

test("normalizeBaseURL: trims surrounding whitespace, preserves the path", () => {
  assert.equal(typeof normalizeBaseURL, "function", "normalizeBaseURL not implemented yet");
  assert.equal(normalizeBaseURL("  https://a/v1  "), "https://a/v1");
  assert.equal(normalizeBaseURL("https://a/v1"), "https://a/v1", "an already-clean URL passes through unchanged");
});

test("normalizeBaseURL: empty / whitespace-only / slash-only input means 'no override' (undefined)", () => {
  assert.equal(typeof normalizeBaseURL, "function", "normalizeBaseURL not implemented yet");
  assert.equal(normalizeBaseURL(""), undefined);
  assert.equal(normalizeBaseURL("   "), undefined);
  assert.equal(normalizeBaseURL("/"), undefined);
});
