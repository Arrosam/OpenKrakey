#!/usr/bin/env -S tsx
/**
 * config-web — bin entry. Resolves the canonical PATHS to absolute paths, reads
 * the port/host/token from the environment (or a sensible default), and starts
 * the server. This is the ONLY place process.* is read.
 */
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { PATHS } from "../../../shared/config";

import { startServer } from "./server";

const cwd = process.cwd();

const port = Number(process.env.CONFIG_WEB_PORT ?? process.argv[2] ?? 7700);
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
});

console.log("✦ Config console: " + url);
