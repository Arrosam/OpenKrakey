#!/usr/bin/env -S tsx
/**
 * cli — bin entry. Parses one optional subcommand, resolves the canonical PATHS
 * to absolute paths, builds the pure Cli core, and hands off to the interactive
 * shell. This is the only place process.argv / process.cwd() are read.
 */
import { resolve } from "node:path";

import { PATHS } from "../../../shared/config";

import { createCli } from "./index";
import { runInteractiveLoop, type InitialPage } from "./pages";

const USAGE = "usage: openkrakey [agent|default|providers]";

function parsePage(args: string[]): InitialPage {
  const cmd = args[0];
  switch (cmd) {
    case undefined:
      return "landing";
    case "agent":
      return "agents";
    case "default":
      return "default";
    case "providers":
      return "providers";
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

const initialPage = parsePage(process.argv.slice(2));

const cwd = process.cwd();
const cli = createCli({
  agentsDir: resolve(cwd, PATHS.agentsDir),
  defaultPath: resolve(cwd, PATHS.defaultPath),
  publicPluginDir: resolve(cwd, PATHS.publicPluginDir),
  llmPath: resolve(cwd, PATHS.llmPath),
});

await runInteractiveLoop(cli, initialPage);
