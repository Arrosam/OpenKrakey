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
import { createCli, CliError } from "../packages/cli/src";
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
// 10. listAvailablePlugins() — subdir names under public_plugin/; missing => []
// ===========================================================================

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
  fs.mkdirSync(path.join(publicPluginDir, "weather"), { recursive: true });
  fs.mkdirSync(path.join(publicPluginDir, "memory"), { recursive: true });
  const cli = makeCli();
  const got = await cli.listAvailablePlugins();
  assert.deepEqual([...got].sort(), ["memory", "weather"]);
});

test("listAvailablePlugins: ignores plain files at the top of public_plugin/", async () => {
  fs.mkdirSync(publicPluginDir, { recursive: true });
  fs.mkdirSync(path.join(publicPluginDir, "realplugin"), { recursive: true });
  // A stray file (e.g. README) must NOT be reported as a plugin.
  fs.writeFileSync(path.join(publicPluginDir, "README.md"), "# plugins", "utf8");
  const cli = makeCli();
  const got = await cli.listAvailablePlugins();
  assert.equal(got.includes("realplugin"), true, "the directory must be listed");
  assert.equal(got.includes("README.md"), false, "a file must not be listed as a plugin");
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
