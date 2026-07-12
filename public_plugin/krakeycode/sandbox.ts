/**
 * krakeycode · sandbox — pure helpers (config parsing, path/command guards,
 * buffer truncation). NO bus. readConfig/guardCommand/truncate stay pure (no
 * I/O); guardPath uses node:fs (realpathSync) to resolve symlinks/junctions so
 * confinement holds against link escapes. The actual filesystem/process work
 * still lives in index.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";

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
  maxResultChars: number;
  maxEntries: number;
  maxResultsTotalChars: number;
  maxFailureNotices: number;
  guidance?: string;
  guidancePriority?: number;
  resultsPriority?: number;
}

/**
 * One persistent-failure ledger entry: a tool that failed with the same
 * normalized error on consecutive frames. `count` is the run length; it is
 * reset (the entry removed) as soon as that tool next succeeds.
 */
export interface FailureEntry {
  toolName: string;
  error: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

/** Longest normalized error string retained per failure entry. */
const FAILURE_ERROR_CAP = 300;

/**
 * Normalize a raw tool error into the ledger key form: stringify, trim, fall
 * back to "unknown" when empty, and cap the length so a giant stderr blob does
 * not bloat the entry (or split otherwise-identical failures).
 */
export function normalizeFailureError(error: unknown): string {
  const s = String(error ?? "").trim();
  const nonEmpty = s.length > 0 ? s : "unknown";
  return nonEmpty.length > FAILURE_ERROR_CAP ? nonEmpty.slice(0, FAILURE_ERROR_CAP) : nonEmpty;
}

/**
 * Record a failed tool call. If the newest matching entry (same toolName + same
 * normalized error) exists it is bumped (count++, lastAt); otherwise a fresh
 * {count:1} entry is appended. The ledger is bounded to `max` by dropping the
 * OLDEST entries (insertion order). `max <= 0` disables the ledger (returns []).
 * Pure: returns a new array, never mutates the input.
 */
export function upsertFailure(
  ledger: FailureEntry[],
  toolName: string,
  rawError: unknown,
  at: number,
  max: number,
): FailureEntry[] {
  if (max <= 0) return [];
  const error = normalizeFailureError(rawError);
  const idx = ledger.findIndex((e) => e.toolName === toolName && e.error === error);
  let next: FailureEntry[];
  if (idx >= 0) {
    next = ledger.map((e, i) =>
      i === idx ? { ...e, count: e.count + 1, lastAt: at } : e,
    );
  } else {
    next = [...ledger, { toolName, error, count: 1, firstAt: at, lastAt: at }];
  }
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * Drop every ledger entry for `toolName` (called when that tool succeeds, which
 * ends any persistent-failure run). Pure: returns a new array.
 */
export function clearFailures(ledger: FailureEntry[], toolName: string): FailureEntry[] {
  return ledger.filter((e) => e.toolName !== toolName);
}

/**
 * Render the persistent-failure notice text for one entry, or "" when the run
 * length is below the alert threshold (count < 2 → nothing to say yet).
 */
export function formatFailureNotice(entry: FailureEntry): string {
  if (entry.count < 2) return "";
  return (
    `[krakeycode persistent failure] ${entry.toolName} has failed ${entry.count}x in a row ` +
    `with the same error: ${entry.error}. This failure is persistent - retrying the same ` +
    `call unchanged will NOT succeed. Reflect on why it is failing and change your approach, ` +
    `or stop and report it; do not keep re-calling it.`
  );
}

/**
 * Parse the raw plugin config slice into a fully-resolved KrakeycodeConfig.
 * Every field is optional in the raw input and falls back to a safe default.
 */
export function readConfig(raw: unknown, dataDir: string): KrakeycodeConfig {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  // Safe by default: sandbox (confined to the plugin's own workspace) unless the
  // operator explicitly opts into "local". An unknown/absent mode → sandbox.
  const mode: "local" | "sandbox" = c.mode === "local" ? "local" : "sandbox";

  const root =
    typeof c.root === "string" && c.root.length > 0
      ? path.resolve(c.root)
      : path.resolve(dataDir);

  const allowWrite = c.allowWrite === false ? false : true;
  // Shell is OFF unless explicitly enabled (c.allowCommands === true). Absent → false.
  const allowCommands = c.allowCommands === true ? true : false;

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
    typeof c.maxResults === "number" && c.maxResults >= 0 ? c.maxResults : 10;

  const maxResultChars =
    typeof c.maxResultChars === "number" && c.maxResultChars > 0
      ? c.maxResultChars
      : 4000;

  const maxEntries =
    typeof c.maxEntries === "number" && c.maxEntries > 0 ? c.maxEntries : 10000;

  const maxResultsTotalChars =
    typeof c.maxResultsTotalChars === "number" && c.maxResultsTotalChars > 0
      ? c.maxResultsTotalChars
      : 16000;

  const maxFailureNotices =
    typeof c.maxFailureNotices === "number" && c.maxFailureNotices >= 0
      ? c.maxFailureNotices
      : 8;

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
    maxResultChars,
    maxEntries,
    maxResultsTotalChars,
    maxFailureNotices,
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
  const realRoot = fs.realpathSync(cfg.root);
  const abs = path.resolve(cfg.root, input);
  let existing = abs;
  const tail: string[] = [];
  for (;;) {
    try { existing = fs.realpathSync(existing); break; }
    catch {
      const parent = path.dirname(existing);
      if (parent === existing) { existing = abs; break; }
      tail.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const canonical = tail.length > 0 ? path.join(existing, ...tail) : existing;
  if (canonical !== realRoot && !canonical.startsWith(realRoot + path.sep)) {
    throw new Error(`krakeycode: path "${input}" escapes the sandbox root "${cfg.root}"`);
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
  if (/[&|;<>`\n\r]/.test(command) || command.includes("$(")) {
    throw new Error("krakeycode: command contains shell control characters that are not allowed in sandbox mode");
  }
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
  if (buf.byteLength <= cap) return { content: buf.toString("utf8"), truncated: false };
  const content = new StringDecoder("utf8").write(buf.subarray(0, cap));
  return { content, truncated: true };
}
