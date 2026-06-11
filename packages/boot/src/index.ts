/**
 * Node: boot — global startup + composition root.
 *
 * The one node (besides agent_instance) permitted to import CONCRETE sibling
 * factories, so it can wire the live object graph via DI. Contains no business
 * logic: it reads agent configs + the LLM config, builds the global
 * CommunicatorLibrary, starts each Agent, and installs graceful shutdown.
 *
 * `npm start` runs `tsx packages/boot/src/index.ts`. The exported functions let
 * tests import this module without launching anything (see the isMain guard).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentInstance } from "../../agent_instance/src";
import { createCommunicatorLibrary } from "../../llm-gateway/src";

import type { AgentDefinition, AgentHandle } from "../../../contracts/agent";
import type { CommunicatorLibrary } from "../../../contracts/llm";
import { PATHS, agentPaths } from "../../../shared/config";
import type { LLMConfig } from "../../../shared/config";
import { consoleLogger } from "../../../shared/logging";
import type { Logger } from "../../../shared/logging";

/**
 * Read every `agents/<id>/config.json` under `agentsDir` into an AgentDefinition.
 * A missing dir yields []; an unreadable/invalid config is warned about and
 * skipped — one bad agent never aborts the rest.
 */
export function loadAgentConfigs(agentsDir: string): AgentDefinition[] {
  const dir = path.resolve(process.cwd(), agentsDir);
  if (!fs.existsSync(dir)) return [];

  const defs: AgentDefinition[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cfgPath = path.resolve(process.cwd(), agentPaths(agentsDir, entry.name).config);
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const def = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as AgentDefinition;
      defs.push(def);
    } catch (err) {
      console.warn("skipping agent '" + entry.name + "': failed to read/parse " + cfgPath + ": " + err);
    }
  }
  return defs;
}

/**
 * Read `config/llm.json` into an LLMConfig. A missing file or a parse error
 * yields an empty catalogue — boot must degrade, not crash, without LLM config.
 */
export function loadLLMConfig(llmPath: string): LLMConfig {
  const p = path.resolve(process.cwd(), llmPath);
  if (!fs.existsSync(p)) return { communicators: {} };
  try {
    const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as LLMConfig;
    // A config that omits `communicators` (or sets it null) degrades to an empty
    // catalogue so downstream consumers never see undefined.
    return cfg.communicators == null ? { ...cfg, communicators: {} } : cfg;
  } catch (err) {
    console.warn("failed to read/parse " + p + ": " + err);
    return { communicators: {} };
  }
}

/**
 * Construct and start an Agent per definition, returning the handles that started
 * successfully. A failure to construct/start one agent is logged and skipped so
 * the remaining agents still come up.
 */
export async function run(
  defs: AgentDefinition[],
  opts?: { library?: CommunicatorLibrary; log?: Logger },
): Promise<AgentHandle[]> {
  const handles: AgentHandle[] = [];
  for (const def of defs) {
    let agent: AgentHandle | undefined;
    try {
      agent = createAgentInstance(def, { library: opts?.library, log: opts?.log });
      await agent.start();
      handles.push(agent);
    } catch (err) {
      // If the handle was created but start() failed, tear it down so plugins
      // that loaded before the failure release their resources. Swallow any
      // teardown error — the loop must still continue to the next def.
      if (agent !== undefined) {
        try {
          await agent.stop();
        } catch {
          // best-effort cleanup
        }
      }
      (opts?.log ?? consoleLogger).error("failed to start agent '" + def.id + "': " + err);
    }
  }
  return handles;
}

/**
 * Friendly pre-flight hints for startup: tell a new user the NEXT step instead
 * of leaving them with silence. No agents → point at the cli; agents without
 * any configured AI service → warn that they can't reply (moot without agents,
 * so at most one hint is ever returned).
 */
export function startupHints(
  defs: AgentDefinition[],
  library: CommunicatorLibrary,
): string[] {
  if (defs.length === 0) {
    return ["No agents yet — run `npm run cli` to set one up (guided setup will walk you through it)."];
  }
  if (library.list().length === 0) {
    return [
      "Warning: no AI service (LLM provider) is configured, so your agents cannot reply — run `npm run cli` and add one under \"AI services\".",
    ];
  }
  return [];
}

/** Process entry point: wire everything, start agents, wait for Ctrl+C. */
async function main(): Promise<void> {
  const defs = loadAgentConfigs(PATHS.agentsDir);
  const llmConfig = loadLLMConfig(PATHS.llmPath);

  // R3: a broken llm.json must not prevent agents from running — degrade to an
  // empty key-less library rather than throwing out of startup.
  let library: CommunicatorLibrary;
  try {
    // Per-communicator failures are skipped + logged (the library still loads the
    // good ones); the outer catch only guards a catastrophic build failure.
    library = createCommunicatorLibrary(llmConfig, {
      onError: (name, err) =>
        consoleLogger.warn(`skipping LLM communicator "${name}": ${err}`),
    });
  } catch (err) {
    consoleLogger.error("LLM library build failed: " + err);
    library = {
      get: () => undefined,
      has: () => false,
      list: () => [],
      withCapability: () => [],
    };
  }

  for (const hint of startupHints(defs, library)) {
    console.log(hint);
  }
  if (defs.length === 0) {
    return;
  }

  const handles = await run(defs, { library, log: consoleLogger });
  console.log("Started " + handles.length + " agent(s). Ctrl+C to stop.");

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    Promise.allSettled(handles.map((h) => h.stop())).then(() => process.exit(0));
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
