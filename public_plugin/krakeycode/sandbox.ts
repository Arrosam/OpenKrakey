/**
 * krakeycode · sandbox — pure helpers (config parsing, path/command guards,
 * buffer truncation). NO I/O, NO bus, NO node:fs. Everything here is
 * deterministic and side-effect free so it can be reasoned about and tested in
 * isolation; the actual filesystem/process work lives in index.ts.
 */
import * as path from "node:path";

/** Fully-resolved krakeycode configuration (all fields concrete). */
export interface KrakeycodeConfig {
  mode: "local" | "sandbox";
  root: string;
  allowWrite: boolean;
  allowCommands: boolean;
  commandAllowlist: string[];
  commandTimeoutMs: number;
  maxReadBytes: number;
  maxOutputBytes: number;
  maxResults: number;
  guidance?: string;
  guidancePriority?: number;
  resultsPriority?: number;
}

/**
 * Parse the raw plugin config slice into a fully-resolved KrakeycodeConfig.
 * Every field is optional in the raw input and falls back to a safe default.
 */
export function readConfig(raw: unknown, dataDir: string): KrakeycodeConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const mode: "local" | "sandbox" = c.mode === "sandbox" ? "sandbox" : "local";

  const root =
    typeof c.root === "string" && c.root.length > 0
      ? path.resolve(c.root)
      : path.resolve(dataDir);

  const allowWrite = c.allowWrite === false ? false : true;
  const allowCommands = c.allowCommands === false ? false : true;

  const commandAllowlist = Array.isArray(c.commandAllowlist)
    ? c.commandAllowlist.filter((x): x is string => typeof x === "string")
    : [];

  const commandTimeoutMs =
    typeof c.commandTimeoutMs === "number" && c.commandTimeoutMs > 0
      ? c.commandTimeoutMs
      : 60000;

  const maxReadBytes =
    typeof c.maxReadBytes === "number" && c.maxReadBytes > 0
      ? c.maxReadBytes
      : 1_000_000;

  const maxOutputBytes =
    typeof c.maxOutputBytes === "number" && c.maxOutputBytes > 0
      ? c.maxOutputBytes
      : 200_000;

  const maxResults =
    typeof c.maxResults === "number" && c.maxResults > 0 ? c.maxResults : 10;

  const cfg: KrakeycodeConfig = {
    mode,
    root,
    allowWrite,
    allowCommands,
    commandAllowlist,
    commandTimeoutMs,
    maxReadBytes,
    maxOutputBytes,
    maxResults,
  };

  if (typeof c.guidance === "string") cfg.guidance = c.guidance;
  if (typeof c.guidancePriority === "number") cfg.guidancePriority = c.guidancePriority;
  if (typeof c.resultsPriority === "number") cfg.resultsPriority = c.resultsPriority;

  return cfg;
}

/**
 * SANDBOX mode only: resolve `input` against the configured root and confirm it
 * does not escape that root. Throws on traversal outside the sandbox.
 */
export function guardPath(input: string, cfg: KrakeycodeConfig): string {
  const abs = path.resolve(cfg.root, input);
  if (!abs.startsWith(cfg.root + path.sep) && abs !== cfg.root) {
    throw new Error(
      `krakeycode: path "${input}" escapes the sandbox root "${cfg.root}"`,
    );
  }
  return abs;
}

/**
 * SANDBOX mode only: enforce the command allowlist. An empty allowlist permits
 * everything; otherwise the first whitespace-delimited token of the command
 * must appear in the allowlist.
 */
export function guardCommand(command: string, cfg: KrakeycodeConfig): void {
  if (cfg.commandAllowlist.length === 0) return;
  const name = command.trimStart().split(/\s+/)[0] ?? "";
  if (!cfg.commandAllowlist.includes(name)) {
    throw new Error(`krakeycode: command "${name}" is not in the allowlist`);
  }
}

/**
 * Decode at most `cap` bytes of `buf` as UTF-8, reporting whether truncation
 * occurred.
 */
export function truncate(buf: Buffer, cap: number): { content: string; truncated: boolean } {
  if (buf.byteLength <= cap) {
    return { content: buf.toString("utf8"), truncated: false };
  }
  return { content: buf.subarray(0, cap).toString("utf8"), truncated: true };
}
