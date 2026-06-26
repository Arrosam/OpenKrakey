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
import * as cp from "node:child_process";
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
import { STAR, dim, failure, mint, success } from "../../../shared/theme";

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

/** The startup report's opening line. */
export function startBanner(): string {
  return mint(STAR) + " OpenKrakey starting…";
}

/**
 * The startup report's closing verdict: how many of the configured agents are
 * actually running, and how to stop. An all-fail batch renders as a failure.
 */
export function summaryLine(started: number, total: number): string {
  const counts = started + "/" + total;
  if (total > 0 && started === 0) {
    return failure("no agents running (" + counts + ") — see the failures above. Ctrl+C to exit.");
  }
  return mint(STAR) + " " + counts + " agent(s) running — Ctrl+C to stop.";
}

/** The exact command that launched this runtime (node + execArgv + script + args). */
function launchCommand(): { exe: string; args: string[] } {
  return { exe: process.execPath, args: [...process.execArgv, ...process.argv.slice(1)] };
}

/**
 * Spawn a DETACHED replacement that waits `delayMs` (so this process can exit and
 * free its loopback ports first), then re-runs the launch command. Cross-platform
 * via the OS shell; quoting guards paths with spaces. (Moved here from the `restart`
 * plugin so the plugin never owns process lifecycle — it only requests a restart.)
 */
function spawnReplacement(delayMs: number): void {
  const { exe, args } = launchCommand();
  const cwd = process.cwd();
  const env = process.env;
  if (process.platform === "win32") {
    const q = (s: string): string => '"' + s.replace(/"/g, '""') + '"';
    const cmd = [exe, ...args].map(q).join(" ");
    const secs = Math.max(1, Math.ceil(delayMs / 1000));
    cp.spawn("cmd.exe", ["/c", "timeout /t " + secs + " /nobreak >nul & " + cmd], {
      cwd, env, detached: true, stdio: "ignore", windowsHide: true,
    }).unref();
  } else {
    const q = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";
    const cmd = [exe, ...args].map(q).join(" ");
    cp.spawn("sh", ["-c", "sleep " + Math.max(0, delayMs) / 1000 + "; exec " + cmd], {
      cwd, env, detached: true, stdio: "ignore",
    }).unref();
  }
}

/**
 * GRACEFUL restart of the whole runtime: stop EVERY agent — running each plugin's
 * teardown, so best-effort state (e.g. the web-chat transcript's read-receipts) is
 * flushed — BEFORE re-execing, unlike a raw `process.exit` which skips teardown.
 * Wired into each Agent (via `createAgentInstance`'s `requestRestart`) so the
 * `restart` plugin's `core.restart` action lands here. `hooks` lets tests substitute
 * the re-exec/exit; the real ones end this process after the replacement is spawned.
 */
export async function requestRestart(
  handles: AgentHandle[],
  delayMs: number,
  hooks?: { spawn?: (delayMs: number) => void; exit?: (code: number) => void },
): Promise<void> {
  await Promise.allSettled(handles.map((h) => h.stop()));
  (hooks?.spawn ?? spawnReplacement)(delayMs);
  (hooks?.exit ?? ((code: number): void => void process.exit(code)))(0);
}

/**
 * Construct and start an Agent per definition, returning the handles that started
 * successfully. A failure to construct/start one agent is logged and skipped so
 * the remaining agents still come up.
 *
 * `report`, when given, receives the human-readable STARTUP REPORT line by
 * line: per agent a starting line, then that agent's plugin starting messages
 * (ctx.print, indented), then a started / FAILED-with-reason verdict.
 */
export async function run(
  defs: AgentDefinition[],
  opts?: {
    library?: CommunicatorLibrary;
    log?: Logger;
    report?: (line: string) => void;
    publicPluginDir?: string;
    agentsDir?: string;
    /** Test seam: substitute the restart re-exec/exit (see requestRestart). */
    restartHooks?: { spawn?: (delayMs: number) => void; exit?: (code: number) => void };
  },
): Promise<AgentHandle[]> {
  const report = opts?.report;
  const handles: AgentHandle[] = [];
  // A graceful restart stops EVERY agent, so the callback closes over the shared
  // `handles` array (fully populated by the time any core.restart fires at runtime).
  const onRestart = (delayMs: number): Promise<void> => requestRestart(handles, delayMs, opts?.restartHooks);
  for (const def of defs) {
    report?.(dim(STAR + " agent '" + def.id + "' starting…"));
    let agent: AgentHandle | undefined;
    try {
      agent = createAgentInstance(def, {
        library: opts?.library,
        log: opts?.log,
        publicPluginDir: opts?.publicPluginDir,
        agentsDir: opts?.agentsDir,
        // Plugin starting messages land indented under their agent's line.
        print: report ? (text) => report("    " + text) : undefined,
        requestRestart: onRestart,
      });
      await agent.start();
      handles.push(agent);
      report?.(success("agent '" + def.id + "' started"));
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
      report?.(failure("agent '" + def.id + "' FAILED: " + err));
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
  console.log(startBanner());
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

  const handles = await run(defs, {
    library,
    log: consoleLogger,
    report: (line) => console.log(line),
  });
  console.log(summaryLine(handles.length, defs.length));
  if (handles.length === 0) {
    // Every configured agent failed: the report above says why; exit non-zero
    // (nothing is running, so don't sit waiting for Ctrl+C).
    process.exitCode = 1;
    return;
  }

  // Graceful shutdown on BOTH SIGINT (Ctrl+C) and SIGTERM (what `krakey stop`/
  // `restart` signal a backgrounded daemon): run every agent's teardown — flushing
  // best-effort state like the web-chat transcript's read-receipts — before exiting,
  // instead of dying mid-write.
  const shutdown = (signal: string): void => {
    console.log(`\n${signal} — shutting down...`);
    Promise.allSettled(handles.map((h) => h.stop())).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
