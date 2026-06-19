/**
 * Plugin: krakeycode  ·  COMPUTER-USE tools for the Agent.
 *
 * Gives the Agent a small, well-known set of filesystem + shell tools
 * (read_file, write_file, edit_file, bash, list_dir) registered with the LLM,
 * plus two context blocks: a SYSTEM guidance block that teaches the model how
 * the tools behave, and a MESSAGES results block that surfaces recent tool
 * outcomes on the next beat.
 *
 * Tool results do NOT come back inline — the orchestrator emits `tool.result`
 * after a call settles; this plugin records the outcome in a bounded ring and
 * (if available) nudges `clock.fire_now` so the Agent wakes to read it.
 *
 * Two security modes:
 *  - "local":   file ops resolve against absolute paths / the working directory.
 *  - "sandbox": file ops are confined to `cfg.root` and `bash` is filtered by
 *               an optional command allowlist.
 *
 * Default export is a PluginFactory — the loader calls it once per Agent, so
 * ALL mutable state (config, results ring, unsubscribes) lives in this closure.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as cp from "node:child_process";

import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Message, ToolDef } from "../../contracts/llm";
import { Actions, Events } from "../../shared/actions";

import { readConfig, guardPath, guardCommand, truncate, type KrakeycodeConfig } from "./sandbox";

const GUIDANCE_BLOCK_ID = "krakeycode.guidance";
const RESULTS_BLOCK_ID = "krakeycode.results";
const DEFAULT_GUIDANCE_PRIORITY = 7000;
const DEFAULT_RESULTS_PRIORITY = 4000;
const PLUGIN_DEV_GUIDE = "docs/PLUGIN_DEV.md";
const OWN_TOOLS = new Set([
  "krakeycode.read_file",
  "krakeycode.write_file",
  "krakeycode.edit_file",
  "krakeycode.bash",
  "krakeycode.list_dir",
]);

interface ResultEntry {
  at: number;
  toolName: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** Append `entry` to the ring, trimming the oldest so length stays <= max. */
function pushResult(ring: ResultEntry[], entry: ResultEntry, max: number): ResultEntry[] {
  const next = [...ring, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Run a shell command, capping captured output and enforcing a hard timeout. */
function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = cp.spawn(command, [], { shell: true, cwd, env: process.env });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout?.on("data", (c: Buffer) => {
      const rem = maxOutputBytes - outBytes;
      if (rem > 0) {
        const s = c.subarray(0, rem);
        outChunks.push(s);
        outBytes += s.byteLength;
      }
    });
    child.stderr?.on("data", (c: Buffer) => {
      const rem = maxOutputBytes - errBytes;
      if (rem > 0) {
        const s = c.subarray(0, rem);
        errChunks.push(s);
        errBytes += s.byteLength;
      }
    });

    const done = (r: {
      command: string;
      exitCode: number;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      durationMs: number;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    child.on("close", (code) =>
      done({
        command,
        exitCode: code ?? -1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
        timedOut: killed,
        durationMs: Date.now() - t0,
      }),
    );
    child.on("error", (err) =>
      done({
        command,
        exitCode: -1,
        stdout: "",
        stderr: String(err),
        timedOut: killed,
        durationMs: Date.now() - t0,
      }),
    );
  });
}

/** Recursively collect directory entries. Sub-dir errors swallow to []. */
function collectEntries(
  dir: string,
  depth: number,
  cur: number,
): Array<{ name: string; type: "file" | "dir" | "other"; size: number }> {
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: Array<{ name: string; type: "file" | "dir" | "other"; size: number }> = [];
  for (const dirent of dirents) {
    const type: "file" | "dir" | "other" = dirent.isFile()
      ? "file"
      : dirent.isDirectory()
        ? "dir"
        : "other";
    const childPath = path.join(dir, dirent.name);
    let size = 0;
    if (type === "file") {
      try {
        size = fs.statSync(childPath).size;
      } catch {
        size = 0;
      }
    }
    out.push({ name: dirent.name, type, size });
    if (type === "dir" && (depth === 0 || cur + 1 < depth)) {
      for (const child of collectEntries(childPath, depth, cur + 1)) {
        out.push({
          name: path.join(dirent.name, child.name),
          type: child.type,
          size: child.size,
        });
      }
    }
  }
  return out;
}

/** Build the default SYSTEM guidance text from the resolved config. */
function buildDefaultGuidance(cfg: KrakeycodeConfig): string {
  const security =
    cfg.mode === "sandbox"
      ? `Security mode: sandbox. File operations are confined to the root "${cfg.root}" — ` +
        `paths that escape it are rejected, and krakeycode.bash is filtered by a command allowlist.`
      : `Security mode: local. File operations use absolute paths or paths relative to the ` +
        `working directory; there is no sandbox confinement.`;

  return (
    "krakeycode gives you computer-use tools:\n" +
    "  - krakeycode.read_file — read a file (utf8 or base64).\n" +
    "  - krakeycode.write_file — write/overwrite/append a file.\n" +
    "  - krakeycode.edit_file — replace a unique snippet in an existing file.\n" +
    "  - krakeycode.bash — run a shell command.\n" +
    "  - krakeycode.list_dir — list a directory tree.\n" +
    "\n" +
    security +
    "\n" +
    `Read/output are capped (reads up to ${cfg.maxReadBytes} bytes, command output up to ${cfg.maxOutputBytes} bytes per stream).\n` +
    "\n" +
    "IMPORTANT: tool results do NOT come back in the same beat. After a tool call " +
    "settles, its result appears on the NEXT beat as a user message tagged " +
    '"krakeycode". Plan for that one-beat delay.\n' +
    "\n" +
    `Before building or extending a plugin, read the plugin-authoring guide at ` +
    `"${PLUGIN_DEV_GUIDE}" via krakeycode.read_file.`
  );
}

/** The five tool declarations registered with the LLM via llm.register_tool. */
function toolDefs(): ToolDef[] {
  return [
    {
      name: "krakeycode.read_file",
      description:
        "Read a file from disk. Returns its content on the NEXT beat (not inline), as a " +
        'user message tagged "krakeycode". Set encoding to \\"base64\\" for binary; defaults ' +
        "to utf8. Content is capped at maxBytes (and the configured read cap); truncation is " +
        "reported. In sandbox mode the path is confined to the configured root. Reading a " +
        "missing path fails.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to read." },
          maxBytes: { type: "number", description: "Optional byte cap for this read." },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Output encoding (default utf8)." },
        },
        required: ["path"],
      },
    },
    {
      name: "krakeycode.write_file",
      description:
        "Write a file. Result returns on the NEXT beat (not inline). Set append:true to " +
        "append instead of overwrite, createDirs:true to create missing parent directories, " +
        'and encoding \\"base64\\" to decode base64 content (default utf8). Gated by allowWrite ' +
        "— when disabled this tool throws. In sandbox mode the path is confined to the root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to write." },
          content: { type: "string", description: "Content to write (utf8 or base64 per encoding)." },
          append: { type: "boolean", description: "Append instead of overwrite." },
          createDirs: { type: "boolean", description: "Create missing parent directories." },
          encoding: { type: "string", enum: ["utf8", "base64"], description: "Content encoding (default utf8)." },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "krakeycode.edit_file",
      description:
        "Replace an exact text snippet in an EXISTING file (the file must already exist). " +
        "Result returns on the NEXT beat (not inline). oldText must be UNIQUE in the file " +
        "unless you pass replaceAll:true; otherwise the edit is rejected so you can add more " +
        "surrounding context. Matching is literal (no regex). Gated by allowWrite — when " +
        "disabled this tool throws. In sandbox mode the path is confined to the root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path to edit (must exist)." },
          oldText: { type: "string", description: "Exact text to replace (unique unless replaceAll)." },
          newText: { type: "string", description: "Replacement text." },
          replaceAll: { type: "boolean", description: "Replace every occurrence." },
        },
        required: ["path", "oldText", "newText"],
      },
    },
    {
      name: "krakeycode.bash",
      description:
        "Run a shell command. The result (exitCode, stdout, stderr, timedOut, durationMs) " +
        "returns on the NEXT beat (not inline). A non-zero exit is NOT an error — you get the " +
        "code. Output is capped per stream and the command is hard-killed on timeout " +
        "(timedOut:true, exitCode:-1). Gated by allowCommands — when disabled this tool throws. " +
        "In sandbox mode commands run in the root and are filtered by the allowlist.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command line to run." },
          cwd: { type: "string", description: "Working directory (ignored in sandbox mode)." },
          timeoutMs: { type: "number", description: "Optional timeout in ms (capped by config)." },
        },
        required: ["command"],
      },
    },
    {
      name: "krakeycode.list_dir",
      description:
        "List a directory tree. Entries return on the NEXT beat (not inline). depth controls " +
        "recursion (1 = immediate children, 0 = unlimited; default 1). In sandbox mode the path " +
        "is confined to the root. Listing a missing/unreadable directory fails.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path to list." },
          depth: { type: "number", description: "Recursion depth (1 = children, 0 = unlimited)." },
        },
        required: ["path"],
      },
    },
  ];
}

const createKrakeycode: PluginFactory = (): Plugin => {
  let cfg: KrakeycodeConfig | undefined;
  let results: ResultEntry[] = [];
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "krakeycode", version: "0.1.0", requires: ["llm.register_tool"] },

    async setup(ctx: PluginContext): Promise<void> {
      const config = readConfig(ctx.config, ctx.dataDir);
      cfg = config;

      // Resolve a caller-supplied path per the active mode.
      const resolve = (p: string): string =>
        config.mode === "sandbox" ? guardPath(p, config) : path.resolve(p);

      // ---- action handlers ----
      const offRead = ctx.actions.register("krakeycode.read_file", async (params: unknown) => {
        const p = (params ?? {}) as { path?: unknown; maxBytes?: unknown; encoding?: unknown };
        if (typeof p.path !== "string" || p.path.length === 0) {
          throw new Error("krakeycode.read_file: 'path' must be a non-empty string");
        }
        const resolved = resolve(p.path);
        const cap = Math.min(
          typeof p.maxBytes === "number" && p.maxBytes > 0 ? p.maxBytes : config.maxReadBytes,
          config.maxReadBytes,
        );
        const buf = fs.readFileSync(resolved);
        if (p.encoding === "base64") {
          return {
            path: resolved,
            encoding: "base64",
            bytes: Math.min(buf.byteLength, cap),
            content: buf.subarray(0, cap).toString("base64"),
            truncated: buf.byteLength > cap,
          };
        }
        const t = truncate(buf, cap);
        return {
          path: resolved,
          encoding: "utf8",
          bytes: Math.min(buf.byteLength, cap),
          content: t.content,
          truncated: t.truncated,
        };
      });

      const offWrite = ctx.actions.register("krakeycode.write_file", async (params: unknown) => {
        if (!config.allowWrite) {
          throw new Error("krakeycode: write is disabled (allowWrite=false)");
        }
        const p = (params ?? {}) as {
          path?: unknown;
          content?: unknown;
          append?: unknown;
          createDirs?: unknown;
          encoding?: unknown;
        };
        if (typeof p.path !== "string" || p.path.length === 0) {
          throw new Error("krakeycode.write_file: 'path' must be a non-empty string");
        }
        if (typeof p.content !== "string") {
          throw new Error("krakeycode.write_file: 'content' must be a string");
        }
        const resolved = resolve(p.path);
        const buf = Buffer.from(p.content, p.encoding === "base64" ? "base64" : "utf8");
        if (p.createDirs === true) {
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
        }
        const existed = fs.existsSync(resolved);
        fs.writeFileSync(resolved, buf, { flag: p.append === true ? "a" : "w" });
        return { path: resolved, bytesWritten: buf.byteLength, created: !existed };
      });

      const offEdit = ctx.actions.register("krakeycode.edit_file", async (params: unknown) => {
        if (!config.allowWrite) {
          throw new Error("krakeycode: write is disabled (allowWrite=false)");
        }
        const p = (params ?? {}) as {
          path?: unknown;
          oldText?: unknown;
          newText?: unknown;
          replaceAll?: unknown;
        };
        if (typeof p.path !== "string" || p.path.length === 0) {
          throw new Error("krakeycode.edit_file: 'path' must be a non-empty string");
        }
        if (typeof p.oldText !== "string" || p.oldText.length === 0) {
          throw new Error("krakeycode.edit_file: 'oldText' must be a non-empty string");
        }
        if (typeof p.newText !== "string") {
          throw new Error("krakeycode.edit_file: 'newText' must be a string");
        }
        const resolved = resolve(p.path);
        const orig = fs.readFileSync(resolved, "utf8");
        const count = orig.split(p.oldText).length - 1;
        if (count === 0) {
          throw new Error(`krakeycode: oldText not found in ${resolved}`);
        }
        if (count > 1 && p.replaceAll !== true) {
          throw new Error(
            `krakeycode: oldText is not unique in ${resolved} (${count} matches) — add surrounding context or pass replaceAll:true`,
          );
        }
        let updated: string;
        if (p.replaceAll === true) {
          // Use split/join (never String.replace) so $ and regex chars stay literal.
          updated = orig.split(p.oldText).join(p.newText);
        } else {
          const idx = orig.indexOf(p.oldText);
          updated = orig.slice(0, idx) + p.newText + orig.slice(idx + p.oldText.length);
        }
        fs.writeFileSync(resolved, updated, "utf8");
        return {
          path: resolved,
          replacements: p.replaceAll === true ? count : 1,
          bytesWritten: Buffer.byteLength(updated, "utf8"),
        };
      });

      const offBash = ctx.actions.register("krakeycode.bash", async (params: unknown) => {
        if (!config.allowCommands) {
          throw new Error("krakeycode: commands are disabled (allowCommands=false)");
        }
        const p = (params ?? {}) as { command?: unknown; cwd?: unknown; timeoutMs?: unknown };
        if (typeof p.command !== "string" || p.command.length === 0) {
          throw new Error("krakeycode.bash: 'command' must be a non-empty string");
        }
        if (config.mode === "sandbox") {
          guardCommand(p.command, config);
        }
        const cwd =
          config.mode === "sandbox"
            ? config.root
            : typeof p.cwd === "string" && p.cwd
              ? path.resolve(p.cwd)
              : config.root;
        const timeoutMs = Math.min(
          typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? p.timeoutMs : config.commandTimeoutMs,
          config.commandTimeoutMs,
        );
        return runShell(p.command, cwd, timeoutMs, config.maxOutputBytes);
      });

      const offList = ctx.actions.register("krakeycode.list_dir", async (params: unknown) => {
        const p = (params ?? {}) as { path?: unknown; depth?: unknown };
        if (typeof p.path !== "string" || p.path.length === 0) {
          throw new Error("krakeycode.list_dir: 'path' must be a non-empty string");
        }
        const resolved = resolve(p.path);
        const depth = typeof p.depth === "number" ? Math.max(0, Math.floor(p.depth)) : 1;
        // Surface a missing/unreadable top-level dir as a throw (ok:false upstream).
        fs.readdirSync(resolved, { withFileTypes: true });
        const entries = collectEntries(resolved, depth, 0);
        return { path: resolved, entries };
      });

      // ---- register tools with the LLM (best-effort; warn + continue) ----
      for (const def of toolDefs()) {
        try {
          await ctx.actions.invoke("llm.register_tool", def);
        } catch (err) {
          ctx.log.warn(`krakeycode: failed to register tool ${def.name}: ${String(err)}`);
        }
      }

      // ---- context blocks ----
      const guidanceText =
        typeof config.guidance === "string" ? config.guidance : buildDefaultGuidance(config);
      ctx.setBlock({
        id: GUIDANCE_BLOCK_ID,
        label: GUIDANCE_BLOCK_ID,
        target: "system",
        priority: config.guidancePriority ?? DEFAULT_GUIDANCE_PRIORITY,
        render: () => guidanceText,
      });

      ctx.setBlock({
        id: RESULTS_BLOCK_ID,
        target: "messages",
        priority: config.resultsPriority ?? DEFAULT_RESULTS_PRIORITY,
        render: (): Message[] =>
          results.length === 0
            ? []
            : results.map((r) => ({
                role: "user",
                name: "krakeycode",
                content:
                  `[krakeycode tool result | ${r.toolName} | ${r.ok ? "ok" : "error"} | ${new Date(r.at).toISOString()}]\n` +
                  (r.ok ? JSON.stringify(r.data, null, 2) : `Error: ${r.error ?? "unknown"}`),
              })),
      });

      // ---- record settled tool results onto the ring; nudge the clock ----
      const offResult = ctx.events.on(Events.TOOL_RESULT, (payload) => {
        if (payload === null || typeof payload !== "object") return;
        const p = payload as {
          name?: unknown;
          at?: unknown;
          ok?: unknown;
          data?: unknown;
          error?: unknown;
        };
        if (typeof p.name !== "string") return;
        if (!OWN_TOOLS.has(p.name)) return;
        results = pushResult(
          results,
          {
            at: typeof p.at === "number" ? p.at : Date.now(),
            toolName: p.name,
            ok: !!p.ok,
            data: p.data,
            error: typeof p.error === "string" ? p.error : undefined,
          },
          config.maxResults,
        );
        if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
          ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
        }
      });

      unsubs = [
        offRead,
        offWrite,
        offEdit,
        offBash,
        offList,
        offResult,
        () => ctx.removeBlock(GUIDANCE_BLOCK_ID),
        () => ctx.removeBlock(RESULTS_BLOCK_ID),
      ];

      ctx.print(`krakeycode: computer-use tools ready (mode=${config.mode}, root=${config.root})`);
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      results = [];
      cfg = undefined;
    },
  };
};

export default createKrakeycode;
