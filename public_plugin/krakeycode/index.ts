/**
 * Plugin: krakeycode  ·  COMPUTER-USE tools for the Agent.
 *
 * Gives the Agent a small, well-known set of filesystem + shell tools
 * (read_file, write_file, edit_file, bash, list_dir) registered with the LLM,
 * plus two context blocks: a SYSTEM guidance block that teaches the model how
 * the tools behave, and a MESSAGES results block that surfaces recent tool
 * outcomes on the next frame.
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
import { StringDecoder } from "node:string_decoder";

import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Message, ToolDef } from "../../contracts/llm";
import { Actions, Events } from "../../shared/actions";

import { readConfig, guardPath, guardCommand, truncate, type KrakeycodeConfig } from "./sandbox";
import { KRAKEYCODE_SCHEMA } from "./config-schema";

const GUIDANCE_BLOCK_ID = "krakeycode.guidance";
const RESULTS_BLOCK_ID = "krakeycode.results";
const DEFAULT_GUIDANCE_PRIORITY = 7000;
const DEFAULT_RESULTS_PRIORITY = 4000;
const PLUGIN_DEV_GUIDE = "docs/PLUGIN_DEV.md";

/** The five tool declarations registered with the LLM via llm.register_tool. */
function toolDefs(): ToolDef[] {
  return [
    {
      name: "krakeycode.read_file",
      description:
        "Read a file from disk. Returns its content on the NEXT frame (not inline), as a " +
        'user message tagged "krakeycode". Set encoding to "base64" for binary; defaults ' +
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
        "Write a file. Result returns on the NEXT frame (not inline). Set append:true to " +
        "append instead of overwrite, createDirs:true to create missing parent directories, " +
        'and encoding "base64" to decode base64 content (default utf8). Gated by allowWrite ' +
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
        "Result returns on the NEXT frame (not inline). oldText must be UNIQUE in the file " +
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
        "returns on the NEXT frame (not inline). A non-zero exit is NOT an error — you get the " +
        "code. Output is capped per stream and the command is hard-killed on timeout " +
        "(timedOut:true, exitCode:-1). Gated by allowCommands — when disabled this tool throws. " +
        "In sandbox mode commands run in the root and are filtered by the allowlist." +
        " The command runs with the host process environment (PATH, etc. inherited).",
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
        "List a directory tree. Entries return on the NEXT frame (not inline). depth controls " +
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

const OWN_TOOLS = new Set(toolDefs().map((d) => d.name));

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
    const isWin = process.platform === "win32";
    const child = cp.spawn(command, [], { shell: true, cwd, env: process.env, detached: !isWin });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let killed = false;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      killed = true;
      if (isWin) {
        try { cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]); } catch { /* best-effort */ }
      } else {
        try { process.kill(-(child.pid as number), "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
      }
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
        stdout: new StringDecoder("utf8").write(Buffer.concat(outChunks)),
        stderr: new StringDecoder("utf8").write(Buffer.concat(errChunks)),
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

interface CollectCtx {
  count: number;
  maxEntries: number;
  visited: Set<string>;
}

/**
 * Recursively collect directory entries. Capped at colCtx.maxEntries total,
 * symlinks are listed but never followed, and realpath-deduped visited dirs
 * guard against cycles (junctions/hardlink loops). Sub-dir read errors swallow
 * and continue. `dirents` is the already-read listing of `dir`.
 */
function collectEntriesInner(
  dir: string,
  depth: number,
  cur: number,
  dirents: fs.Dirent[],
  colCtx: CollectCtx,
): Array<{ name: string; type: "file" | "dir" | "other"; size: number }> {
  const out: Array<{ name: string; type: "file" | "dir" | "other"; size: number }> = [];
  for (const dirent of dirents) {
    if (colCtx.count >= colCtx.maxEntries) break;
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
    colCtx.count++;

    if (type === "dir" && !dirent.isSymbolicLink() && (depth === 0 || cur + 1 < depth)) {
      let real: string;
      try {
        real = fs.realpathSync(childPath);
      } catch {
        continue;
      }
      if (colCtx.visited.has(real)) continue;
      colCtx.visited.add(real);

      let childDirents: fs.Dirent[];
      try {
        childDirents = fs.readdirSync(childPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of collectEntriesInner(childPath, depth, cur + 1, childDirents, colCtx)) {
        out.push({
          name: path.join(dirent.name, child.name),
          type: child.type,
          size: child.size,
        });
      }
      if (colCtx.count >= colCtx.maxEntries) break;
    }
  }
  return out;
}

/** Build the default SYSTEM guidance text from the resolved config. */
function buildDefaultGuidance(cfg: KrakeycodeConfig): string {
  const security =
    cfg.mode === "sandbox"
      ? `Security mode: sandbox (the default). File operations are confined to your own workspace "${cfg.root}" — ` +
        `paths that escape it are rejected. ` +
        (cfg.allowCommands
          ? `krakeycode.bash is filtered by a command allowlist.`
          : `krakeycode.bash (shell) is disabled.`) +
        ` To work with files elsewhere on the computer or run shell commands, the operator must widen krakeycode's ` +
        `config (mode "local" and/or allowCommands true).`
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
    "IMPORTANT: tool results do NOT come back in the same frame. After a tool call " +
    "settles, its result appears on the NEXT frame as a user message tagged " +
    '"krakeycode". Plan for that one-frame delay.\n' +
    "\n" +
    `Before building or extending a plugin, read the plugin-authoring guide at ` +
    `"${PLUGIN_DEV_GUIDE}" via krakeycode.read_file.`
  );
}

const createKrakeycode: PluginFactory = (): Plugin => {
  let results: ResultEntry[] = [];
  let unsubs: Array<() => void> = [];

  return {
    manifest: { id: "krakeycode", version: "0.1.0", requires: ["llm.register_tool"], configSchema: KRAKEYCODE_SCHEMA },

    async setup(ctx: PluginContext): Promise<void> {
      const { actions, events, log, setBlock, removeBlock, print } = ctx;
      const config = readConfig(ctx.config, ctx.dataDir);
      if (config.mode === "sandbox") {
        try { fs.mkdirSync(config.root, { recursive: true }); } catch { /* best-effort */ }
      }

      // Resolve a caller-supplied path per the active mode.
      const resolve = (p: string): string =>
        config.mode === "sandbox" ? guardPath(p, config) : path.resolve(p);

      // ---- action handlers ----
      const offRead = actions.register("krakeycode.read_file", async (params: unknown) => {
        const p = (params ?? {}) as { path?: unknown; maxBytes?: unknown; encoding?: unknown };
        if (typeof p.path !== "string" || p.path.length === 0) {
          throw new Error("krakeycode.read_file: 'path' must be a non-empty string");
        }
        const resolved = resolve(p.path);
        const cap = Math.min(
          typeof p.maxBytes === "number" && p.maxBytes >= 0 ? p.maxBytes : config.maxReadBytes,
          config.maxReadBytes,
        );
        const fd = fs.openSync(resolved, "r");
        try {
          const size = fs.fstatSync(fd).size;
          const toRead = Math.min(size, cap);
          const buf = Buffer.alloc(toRead);
          if (toRead > 0) fs.readSync(fd, buf, 0, toRead, 0);
          if (p.encoding === "base64") {
            return { path: resolved, encoding: "base64", bytes: toRead, content: buf.toString("base64"), truncated: size > cap };
          }
          return { path: resolved, encoding: "utf8", bytes: toRead, content: truncate(buf, toRead).content, truncated: size > cap };
        } finally { fs.closeSync(fd); }
      });

      const offWrite = actions.register("krakeycode.write_file", async (params: unknown) => {
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

      const offEdit = actions.register("krakeycode.edit_file", async (params: unknown) => {
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

      const offBash = actions.register("krakeycode.bash", async (params: unknown) => {
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
              : process.cwd();
        const timeoutMs = Math.min(
          typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? p.timeoutMs : config.commandTimeoutMs,
          config.commandTimeoutMs,
        );
        return runShell(p.command, cwd, timeoutMs, config.maxOutputBytes);
      });

      const offList = actions.register("krakeycode.list_dir", async (params: unknown) => {
        const p = (params ?? {}) as { path?: unknown; depth?: unknown };
        if (typeof p.path !== "string" || p.path.length === 0) {
          throw new Error("krakeycode.list_dir: 'path' must be a non-empty string");
        }
        const resolved = resolve(p.path);
        const depth = typeof p.depth === "number" ? Math.max(0, Math.floor(p.depth)) : 1;
        // Surface a missing/unreadable top-level dir as a throw (ok:false upstream).
        const topDirents = fs.readdirSync(resolved, { withFileTypes: true });
        let realTop;
        try { realTop = fs.realpathSync(resolved); } catch { realTop = resolved; }
        const entries = collectEntriesInner(resolved, depth, 0, topDirents, {
          count: 0,
          maxEntries: config.maxEntries,
          visited: new Set([realTop]),
        });
        return { path: resolved, entries };
      });

      // ---- register tools with the LLM (best-effort; warn + continue) ----
      for (const def of toolDefs()) {
        try {
          await actions.invoke("llm.register_tool", def);
        } catch (err) {
          log.warn(`krakeycode: failed to register tool ${def.name}: ${String(err)}`);
        }
      }

      // ---- context blocks ----
      const guidanceText =
        typeof config.guidance === "string" ? config.guidance : buildDefaultGuidance(config);
      setBlock({
        id: GUIDANCE_BLOCK_ID,
        label: GUIDANCE_BLOCK_ID,
        target: "system",
        priority: config.guidancePriority ?? DEFAULT_GUIDANCE_PRIORITY,
        render: () => guidanceText,
      });

      setBlock({
        id: RESULTS_BLOCK_ID,
        target: "messages",
        priority: config.resultsPriority ?? DEFAULT_RESULTS_PRIORITY,
        render: (): Message[] => {
          if (results.length === 0) return [];
          const maxChars = config.maxResultChars;
          const budget = config.maxResultsTotalChars;
          const headerOf = (r: ResultEntry): string =>
            `[krakeycode tool result | ${r.toolName} | ${r.ok ? "ok" : "error"} | ${new Date(r.at).toISOString()}]`;
          const bodyOf = (r: ResultEntry): string => {
            const raw = r.ok ? JSON.stringify(r.data, null, 2) : `Error: ${r.error ?? "unknown"}`;
            return raw.length > maxChars ? raw.slice(0, maxChars) + `\n…(${raw.length - maxChars} chars truncated)` : raw;
          };
          // decide full vs header-only, newest first
          const full = new Array(results.length).fill(false);
          let total = 0;
          for (let i = results.length - 1; i >= 0; i--) {
            const h = headerOf(results[i]);
            const b = bodyOf(results[i]);
            const len = h.length + 1 + b.length;
            if (i === results.length - 1 || total + len <= budget) { full[i] = true; total += len; }
            else break; // this and all older stay header-only
          }
          return results.map((r, i) => ({
            role: "user",
            name: "krakeycode",
            content: full[i] ? headerOf(r) + "\n" + bodyOf(r) : headerOf(r),
          } as Message));
        },
      });

      // ---- record settled tool results onto the ring; nudge the clock ----
      const offResult = events.on(Events.TOOL_RESULT, (payload) => {
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
        if (actions.has(Actions.CLOCK_FIRE_NOW)) {
          actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
        }
      });

      unsubs = [
        offRead,
        offWrite,
        offEdit,
        offBash,
        offList,
        offResult,
        () => removeBlock(GUIDANCE_BLOCK_ID),
        () => removeBlock(RESULTS_BLOCK_ID),
      ];

      print(`krakeycode: computer-use tools ready (mode=${config.mode}, root=${config.root})`);
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      results = [];
    },
  };
};

export default createKrakeycode;
