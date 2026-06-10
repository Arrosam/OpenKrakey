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

export interface LoaderDeps {
  agentId: string;
  def: AgentDefinition;
  events: EventSystem;
  orchestrator: Orchestrator;
  library: CommunicatorLibrary;
  publicPluginDir: string;
  agentDir: string;
  log?: Logger;
}

export function createLoader(deps: LoaderDeps): Loader {
  const log = tagged(deps.log ?? consoleLogger, "[loader:" + deps.agentId + "]");
  const loaded: Array<{ plugin: Plugin; ctx: PluginContext }> = [];

  /** A simple plugin name: no path separators, no `.`/`..`. */
  const VALID_ID = /^[A-Za-z0-9._-]+$/;
  function validateId(id: string): void {
    if (id === "." || id === ".." || !VALID_ID.test(id)) {
      throw new PluginLoadError("invalid plugin id: '" + id + "'");
    }
  }

  async function load(): Promise<void> {
    // 0. VALIDATE every declared plugin id BEFORE any filesystem copy or import.
    for (const id of deps.def.privatePlugins ?? []) {
      validateId(id);
    }
    for (const id of deps.def.plugins ?? []) {
      validateId(id);
    }

    // 1. COPY declared independents into the agent's private plugins folder.
    //    Code is copied; the source's accumulated top-level data/ is not.
    for (const id of deps.def.privatePlugins ?? []) {
      const src = path.join(deps.publicPluginDir, id);
      const dst = path.join(deps.agentDir, "plugins", id);
      if (fs.existsSync(dst)) {
        // Already present — preserve the agent's private data.
        continue;
      }
      if (fs.existsSync(src)) {
        const srcDataDir = path.join(src, "data");
        fs.cpSync(src, dst, {
          recursive: true,
          filter: (s) => s !== srcDataDir,
        });
      } else {
        throw new PluginLoadError("private plugin source not found: " + id);
      }
    }

    // 2. RESOLVE plugin dirs (pluginId -> absolute code dir).
    //    Private folder is scanned first (sorted by name for determinism) so it
    //    overrides same-id public; declared public plugins keep their order after.
    const resolved = new Map<string, string>();

    const privateDir = path.join(deps.agentDir, "plugins");
    if (fs.existsSync(privateDir)) {
      const entries = fs
        .readdirSync(privateDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        resolved.set(entry.name, path.join(privateDir, entry.name));
      }
    }

    for (const id of deps.def.plugins ?? []) {
      if (!resolved.has(id)) {
        resolved.set(id, path.join(deps.publicPluginDir, id));
      }
    }

    // 3. PASS 1 — resolve + import + validate every plugin's default export,
    //    collecting the full load set before any setup runs.
    const loadSet: Array<{ id: string; plugin: Plugin; dir: string }> = [];
    for (const [id, pluginDir] of resolved) {
      const plugin = await importPlugin(id, pluginDir);
      loadSet.push({ id, plugin, dir: pluginDir });
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
      for (const { id, plugin, dir } of loadSet) {
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
          dataDir: path.join(dir, "data"),
          llm: deps.library,
          setBlock: (b) => deps.orchestrator.setBlock(b),
          getBlock: (bid) => deps.orchestrator.getBlock(bid),
          removeBlock: (bid) => deps.orchestrator.removeBlock(bid),
          listBlocks: () => deps.orchestrator.listBlocks(),
          log: (msg) => log.info("[" + id + "] " + msg),
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

  /** Dynamic-import a plugin: prefer index.ts, fall back to index.js. */
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

    const plugin = mod.default as Plugin;
    if (
      !plugin ||
      typeof plugin !== "object" ||
      typeof plugin.manifest !== "object" ||
      typeof plugin.setup !== "function"
    ) {
      throw new PluginLoadError("plugin '" + id + "' has no valid default export");
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
        log.error("teardown failed for '" + plugin.manifest.id + "': " + err);
      }
    }
    loaded.length = 0;
  }

  async function teardown(): Promise<void> {
    await rollback();
  }

  return { load, teardown };
}
