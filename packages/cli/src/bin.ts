#!/usr/bin/env -S tsx
/**
 * cli — bin entry. The top-level `krakey <command>` dispatcher: a thin process
 * shell that reads process.argv, hands it to the pure parser (./dispatcher),
 * then either runs the interactive config console in-process or spawns a sibling
 * bin (boot for `start`, config-web for `dashboard`) as a child. This is the
 * only place process.argv / process.cwd() / fs / spawn are touched.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PATHS } from "../../../shared/config";

import { parseCommand } from "./dispatcher";
import { createCli } from "./index";
import { runInteractiveLoop } from "./pages";

// Version comes from the repo-root package.json, resolved relative to this file
// (NOT cwd) so `krakey version` is stable wherever it is invoked from.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
) as { version: string };

// Sibling bins, resolved as absolute paths from this file's location. They are
// passed as strings to the child; this worktree need not contain them.
const bootBin = fileURLToPath(new URL("../../boot/src/index.ts", import.meta.url));
const configWebBin = fileURLToPath(new URL("../../config-web/src/bin.ts", import.meta.url));

const USAGE = `usage: krakey [command]

commands:
  krakey              open the config console (landing menu)
  krakey setup        open the config console (landing menu)
  krakey agent        edit agents
  krakey default      edit default settings (the template new agents copy)
  krakey providers    edit AI services (providers, endpoints, keys)
  krakey start        launch the runtime (all configured agents)
  krakey dashboard    launch the config web UI  [port]
  krakey help         show this help
  krakey version      print the version`;

/**
 * Launch a sibling bin the way `npm test` runs tsx — `node --import tsx <bin>`.
 * The child shares this process group, so it handles Ctrl+C itself; we keep the
 * parent alive and just mirror the child's exit code.
 */
function spawnChild(binPath: string, extraArgs: string[]): void {
  const child = spawn(process.execPath, ["--import", "tsx", binPath, ...extraArgs], {
    stdio: "inherit",
  });
  process.on("SIGINT", () => {});
  child.on("error", (err) => {
    console.error(`krakey: failed to launch ${binPath}: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}

const parsed = parseCommand(process.argv.slice(2));

switch (parsed.kind) {
  case "help":
    console.log(USAGE);
    break;
  case "version":
    console.log(pkg.version);
    break;
  case "start":
    spawnChild(bootBin, []);
    break;
  case "dashboard":
    // config-web reads the port from its own process.argv[2].
    spawnChild(configWebBin, parsed.port !== undefined ? [parsed.port] : []);
    break;
  case "setup": {
    const cwd = process.cwd();
    const cli = createCli({
      agentsDir: resolve(cwd, PATHS.agentsDir),
      defaultPath: resolve(cwd, PATHS.defaultPath),
      publicPluginDir: resolve(cwd, PATHS.publicPluginDir),
      llmPath: resolve(cwd, PATHS.llmPath),
    });
    await runInteractiveLoop(cli, parsed.page);
    break;
  }
  case "unknown":
    console.error(`krakey: unknown command '${parsed.token}'\n\n${USAGE}`);
    process.exitCode = 1;
    break;
}
