/**
 * loader — per-Agent plugin lifecycle.
 *
 * Resolves this Agent's plugins (copy declared independents into the agent's
 * private folder, auto-load that folder which overrides same-id public, then
 * load declared public plugins), builds each plugin's PluginContext, and
 * registers it via `setup`. `teardown` tears every loaded plugin down in
 * reverse load order. The loader does NOT run the beat.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { Loader } from "../../../contracts/loader";
import type { Plugin, PluginContext } from "../../../contracts/plugin";
import type { EventSystem } from "../../../contracts/event-system";
import type { Orchestrator } from "../../../contracts/orchestrator";
import type { AgentDefinition } from "../../../contracts/agent";
import type { CommunicatorLibrary } from "../../../contracts/llm";
import { DependencyError, PluginLoadError } from "../../../shared/errors";
import { type Logger, consoleLogger, tagged } from "../../../shared/logging";
import { Events } from "../../../shared/actions";

export interface LoaderDeps {
  agentId: string;
  def: AgentDefinition;
  events: EventSystem;
  orchestrator: Orchestrator;
  library: CommunicatorLibrary;
  publicPluginDir: string;
  agentDir: string;
  log?: Logger;
  /**
   * Sink for plugin ctx.print lines (clean user-facing text, e.g. a plugin's
   * starting message). The composition root wires this into the console that
   * ran the program; defaults to plain stdout.
   */
  print?: (text: string) => void;
}

export function createLoader(deps: LoaderDeps): Loader {
  const log = tagged(deps.log ?? consoleLogger, "[loader:" + deps.agentId + "]");
  const printSink = deps.print ?? ((text: string) => console.log(text));
  const loaded: Array<{ plugin: Plugin; ctx: PluginContext }> = [];

  /** Mirror one plugin console line onto this Agent's own bus (Events.LOG). */
  const pushLogEntry = (
    level: "info" | "warn" | "error" | "print",
    pluginId: string,
    text: string,
  ): void => {
    deps.events.events.emit(Events.LOG, {
      at: Date.now(),
      data: { level, pluginId, text },
    });
  };

  /** A simple plugin name: no path separators, no `.`/`..`. */
  const VALID_ID = /^[A-Za-z0-9._-]+$/;
  function validateId(id: string): void {
    if (id === "." || id === ".." || !VALID_ID.test(id)) {
      throw new PluginLoadError("invalid plugin id: '" + id + "'");
    }
  }

  async function load(): Promise<void> {
    // 0. VALIDATE every declared plugin id BEFORE any filesystem access or import.
    for (const id of deps.def.privatePlugins ?? []) {
      validateId(id);
    }
    for (const id of deps.def.plugins ?? []) {
      validateId(id);
    }

    // 1. RESOLVE each plugin's CODE dir + DATA dir. Plugins are NEVER copied:
    //    declared independents load their code straight from public_plugin/ (so
    //    the code's relative imports keep resolving — the PluginFactory already
    //    gives each Agent its own instance), and "independent" only redirects the
    //    dataDir to the agent-private folder. Code precedence per id:
    //      custom code in agents/<id>/plugins/<pid>/  >  public_plugin/<pid>/
    //    Data location per id:
    //      custom-folder OR declared independent  -> agents/<id>/plugins/<pid>/data
    //      plain public                            -> public_plugin/<pid>/data (shared)
    const privateDir = path.join(deps.agentDir, "plugins");
    // A private-folder subdir counts as a CODE override only if it actually
    // holds a plugin entry — a bare `<pid>/data/` (an independent plugin's
    // agent-private data) must NOT be mistaken for custom code.
    const hasEntry = (dir: string): boolean =>
      fs.existsSync(path.join(dir, "index.ts")) || fs.existsSync(path.join(dir, "index.js"));
    const customIds = new Set<string>();
    if (fs.existsSync(privateDir)) {
      for (const entry of fs.readdirSync(privateDir, { withFileTypes: true })) {
        if (entry.isDirectory() && hasEntry(path.join(privateDir, entry.name))) {
          customIds.add(entry.name);
        }
      }
    }
    const independentIds = new Set(deps.def.privatePlugins ?? []);

    const resolveOne = (id: string): { codeDir: string; dataDir: string } => {
      if (customIds.has(id)) {
        const dir = path.join(privateDir, id);
        return { codeDir: dir, dataDir: path.join(dir, "data") };
      }
      if (independentIds.has(id)) {
        const src = path.join(deps.publicPluginDir, id);
        if (!fs.existsSync(src)) {
          throw new PluginLoadError("private plugin source not found: " + id);
        }
        return { codeDir: src, dataDir: path.join(privateDir, id, "data") };
      }
      const src = path.join(deps.publicPluginDir, id);
      return { codeDir: src, dataDir: path.join(src, "data") };
    };

    // Load ORDER (deterministic): declared `plugins` first, in array order (so a
    // plugin can rely on an earlier one's setup-time action — see `requires`),
    // then any declared independents not in `plugins`, then any custom
    // private-folder plugins declared nowhere (sorted).
    const resolved = new Map<string, { codeDir: string; dataDir: string }>();
    for (const id of deps.def.plugins ?? []) {
      if (!resolved.has(id)) resolved.set(id, resolveOne(id));
    }
    for (const id of deps.def.privatePlugins ?? []) {
      if (!resolved.has(id)) resolved.set(id, resolveOne(id));
    }
    for (const id of [...customIds].sort()) {
      if (!resolved.has(id)) resolved.set(id, resolveOne(id));
    }

    // 2. PASS 1 — import + validate every plugin (one instance per Agent via its
    //    factory), collecting the full load set before any setup runs.
    const loadSet: Array<{ id: string; plugin: Plugin; dataDir: string }> = [];
    for (const [id, { codeDir, dataDir }] of resolved) {
      const plugin = await importPlugin(id, codeDir);
      loadSet.push({ id, plugin, dataDir });
    }

    // The set of ids + provided capabilities, independent of load order.
    const available = new Set<string>();
    for (const { id, plugin } of loadSet) {
      available.add(id);
      for (const cap of plugin.manifest.provides ?? []) {
        available.add(cap);
      }
    }

    // 4. PASS 2 — per plugin IN ORDER: check requires, build context, setup.
    //    All-or-nothing: ANY throw here (requires check, context build, or
    //    setup) tears down the plugins already set up before rethrowing.
    //    Pass 1 needs no rollback — nothing is set up yet.
    try {
      for (const { id, plugin, dataDir } of loadSet) {
        // a. Verify declared requirements. An entry with a dot is an ACTION name
        //    checked against the actionbus at THIS plugin's setup time (order-
        //    dependent); any other entry must be a plugin id or provided
        //    capability somewhere in the load set (order-independent).
        for (const req of plugin.manifest.requires ?? []) {
          const met = req.includes(".") ? deps.events.actions.has(req) : available.has(req);
          if (!met) {
            throw new DependencyError(
              "plugin '" + id + "' requires '" + req + "' which is not available",
            );
          }
        }

        // b. Build the PluginContext.
        const ctx: PluginContext = {
          agentId: deps.agentId,
          events: deps.events.events,
          actions: deps.events.actions,
          config: deps.def.config?.[id] ?? {},
          dataDir,
          llm: deps.library,
          setBlock: (b) => deps.orchestrator.setBlock(b),
          getBlock: (bid) => deps.orchestrator.getBlock(bid),
          removeBlock: (bid) => deps.orchestrator.removeBlock(bid),
          listBlocks: () => deps.orchestrator.listBlocks(),
          // Diagnostics go to the host Logger tagged with the plugin id; the
          // user-facing print goes VERBATIM to the print sink. Both are also
          // pushed on this Agent's bus as log.entry so channels can mirror them.
          log: {
            info: (msg) => {
              log.info("[" + id + "] " + msg);
              pushLogEntry("info", id, msg);
            },
            warn: (msg) => {
              log.warn("[" + id + "] " + msg);
              pushLogEntry("warn", id, msg);
            },
            error: (msg) => {
              log.error("[" + id + "] " + msg);
              pushLogEntry("error", id, msg);
            },
          },
          print: (text) => {
            printSink(text);
            pushLogEntry("print", id, text);
          },
        };

        // c. Register the plugin.
        await plugin.setup(ctx);
        loaded.push({ plugin, ctx });
      }
    } catch (err) {
      await rollback();
      throw err;
    }
  }

  /**
   * Dynamic-import a plugin (prefer index.ts, fall back to index.js) and
   * INSTANTIATE it: the default export is a PluginFactory called once per
   * Agent (ESM caches the module, so shared code never yields shared state —
   * R6). A non-factory default, a throwing factory, or a malformed instance
   * all reject with PluginLoadError.
   */
  async function importPlugin(id: string, pluginDir: string): Promise<Plugin> {
    const tsEntry = path.join(pluginDir, "index.ts");
    const jsEntry = path.join(pluginDir, "index.js");
    const entry = fs.existsSync(tsEntry)
      ? tsEntry
      : fs.existsSync(jsEntry)
        ? jsEntry
        : undefined;
    if (!entry) {
      throw new PluginLoadError("plugin '" + id + "' has no index.ts or index.js entry");
    }

    let mod: Record<string, unknown>;
    try {
      mod = await import(pathToFileURL(entry).href);
    } catch (err) {
      throw new PluginLoadError("failed to import plugin '" + id + "': " + err);
    }

    const factory = mod.default;
    if (typeof factory !== "function") {
      throw new PluginLoadError(
        "plugin '" + id + "' must default-export a factory (() => Plugin), got " + typeof factory,
      );
    }

    let plugin: Plugin;
    try {
      plugin = (factory as () => Plugin)();
    } catch (err) {
      throw new PluginLoadError("plugin '" + id + "' factory threw during construction: " + err);
    }

    if (
      !plugin ||
      typeof plugin !== "object" ||
      typeof plugin.manifest !== "object" ||
      typeof plugin.setup !== "function"
    ) {
      throw new PluginLoadError("plugin '" + id + "' factory did not return a valid Plugin");
    }
    return plugin;
  }

  /** Tear down already-set-up plugins in reverse order, isolating each error. */
  async function rollback(): Promise<void> {
    for (let i = loaded.length - 1; i >= 0; i--) {
      const { plugin } = loaded[i];
      try {
        await plugin.teardown?.();
      } catch (err) {
        const detail = "teardown failed for '" + plugin.manifest.id + "': " + err;
        log.error(detail);
        pushLogEntry("error", "core:loader", detail);
      }
    }
    loaded.length = 0;
  }

  async function teardown(): Promise<void> {
    await rollback();
  }

  return { load, teardown };
}
