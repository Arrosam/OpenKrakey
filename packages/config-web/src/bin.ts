#!/usr/bin/env -S tsx
/**
 * config-web — bin entry. Resolves the canonical PATHS to absolute paths, reads
 * the port/host/token from the environment (or a sensible default), and starts
 * the server. This is the ONLY place process.* is read.
 */
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { PATHS } from "../../../shared/config";

import { startServer } from "./server";

const cwd = process.cwd();

// The `krakey` CLI bin (resolved from THIS file, not cwd). POST /api/restart runs
// `krakey restart` through it — stop the tracked background runtime, then start a
// fresh one — the same lifecycle `krakey restart` drives from the terminal.
// NOT detached: `krakey restart` is short-lived (it stops the old daemon and spawns
// the new one as its OWN detached child, then exits), and a DETACHED tsx child here
// fails to run on Windows. We just fire-and-forget it (unref'd, output ignored);
// this long-lived server easily outlives its ~2s run.
const cliBin = fileURLToPath(new URL("../../cli/src/bin.ts", import.meta.url));
function restartRuntime(): void {
  const child = spawn(process.execPath, ["--import", "tsx", cliBin, "restart"], {
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    /* best-effort: a failed restart spawn must never crash the config server */
  });
  child.unref();
}

function parsePort(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (s === "") return 7717;
  const n = Number(s);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.warn(`[config-web] invalid port "${s}", falling back to 7717`);
    return 7717;
  }
  return n;
}
const port = parsePort(process.env.CONFIG_WEB_PORT ?? process.argv[2]);
const host = process.env.CONFIG_WEB_HOST ?? "127.0.0.1";
const token = process.env.CONFIG_WEB_TOKEN || randomBytes(16).toString("hex");

const { url } = await startServer({
  port,
  host,
  token,
  agentsDir: resolve(cwd, PATHS.agentsDir),
  defaultPath: resolve(cwd, PATHS.defaultPath),
  publicPluginDir: resolve(cwd, PATHS.publicPluginDir),
  llmPath: resolve(cwd, PATHS.llmPath),
  restart: restartRuntime,
});

console.log("✦ Config console: " + url);
