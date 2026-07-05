#!/usr/bin/env -S tsx
/**
 * console — bin entry. Reads the port/host and the three surface URLs from the
 * environment (or sensible loopback defaults) and starts the static server. This
 * is the ONLY place process.* is read.
 *
 *   CONSOLE_PORT   default 7716 (also accepts argv[2]; 0 = ephemeral port)
 *   CONSOLE_HOST   default 127.0.0.1
 *   CONFIG_WEB_URL default http://127.0.0.1:7717  (the Config surface)
 *   WEB_CHAT_URL   default http://127.0.0.1:7718  (the Chat surface)
 *   INSPECTOR_URL  default http://127.0.0.1:7719  (the Inspector surface)
 *   CONSOLE_TOKEN  the session token gating the shell + /api/status; when unset a
 *                  fresh random one is minted per run (the Console is never open —
 *                  the tokened URL is printed below)
 */
import { randomBytes } from "node:crypto";
import { startServer } from "./server";

function parsePort(raw: string | undefined): number {
  const s = (raw ?? "").trim();
  if (s === "") return 7716;
  const n = Number(s);
  // 0 is valid here: it asks the OS for an ephemeral port.
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.warn(`[console] invalid port "${s}", falling back to 7716`);
    return 7716;
  }
  return n;
}

const port = parsePort(process.env.CONSOLE_PORT ?? process.argv[2]);
const host = process.env.CONSOLE_HOST ?? "127.0.0.1";
const configUrl = process.env.CONFIG_WEB_URL ?? "http://127.0.0.1:7717";
const chatUrl = process.env.WEB_CHAT_URL ?? "http://127.0.0.1:7718";
const inspectorUrl = process.env.INSPECTOR_URL ?? "http://127.0.0.1:7719";
// Always have a token — mint a random one when none is configured, so the
// Console is never served open. The URL returned by startServer already carries
// it as `?token=`.
const token = process.env.CONSOLE_TOKEN || randomBytes(16).toString("hex");

const { url } = await startServer({ port, host, configUrl, chatUrl, inspectorUrl, token });

console.log("✦ Krakey Console: " + url);
