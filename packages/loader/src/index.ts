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

  async function load(): Promise<void> {
    // 1. COPY declared independents into the agent's private plugins folder.
    for (const id of deps.def.privatePlugins ?? []) {
      const src = path.join(deps.publicPluginDir, id);
      const dst = path.join(deps.agentDir, "plugins", id);
      if (fs.existsSync(dst)) {
        // Already present — preserve the agent's private data.
        continue;
      }
      if (fs.existsSync(src)) {
        fs.cpSync(src, dst, { recursive: true });
      } else {
        throw new PluginLoadError("private plugin source not found: " + id);
      }
    }

    // 2. RESOLVE plugin dirs (pluginId -> absolute code dir).
    //    Private folder is scanned first so it overrides same-id public.
    const resolved = new Map<string, string>();

    const privateDir = path.join(deps.agentDir, "plugins");
    if (fs.existsSync(privateDir)) {
      for (const entry of fs.readdirSync(privateDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          resolved.set(entry.name, path.join(privateDir, entry.name));
        }
      }
    }

    for (const id of deps.def.plugins ?? []) {
      if (!resolved.has(id)) {
        resolved.set(id, path.join(deps.publicPluginDir, id));
      }
    }

    // 3. Load each plugin in insertion order.
    for (const [id, pluginDir] of resolved) {
      // a. Dynamic-import the module.
      let mod: Record<string, unknown>;
      try {
        mod = await import(pathToFileURL(path.join(pluginDir, "index.ts")).href);
      } catch (err) {
        throw new PluginLoadError("failed to import plugin '" + id + "': " + err);
      }

      // b. Validate the default-export shape.
      const plugin = mod.default as Plugin;
      if (
        !plugin ||
        typeof plugin !== "object" ||
        typeof plugin.manifest !== "object" ||
        typeof plugin.setup !== "function"
      ) {
        throw new PluginLoadError("plugin '" + id + "' has no valid default export");
      }

      // c. Verify declared requirements.
      for (const req of plugin.manifest.requires ?? []) {
        const met = req.includes(".")
          ? deps.events.actions.has(req)
          : loaded.some((l) => l.plugin.manifest.id === req);
        if (!met) {
          throw new DependencyError(
            "plugin '" + id + "' requires '" + req + "' which is not available",
          );
        }
      }

      // d. Build the PluginContext.
      const ctx: PluginContext = {
        agentId: deps.agentId,
        events: deps.events.events,
        actions: deps.events.actions,
        config: deps.def.config?.[id] ?? {},
        dataDir: path.join(pluginDir, "data"),
        llm: deps.library,
        setBlock: (b) => deps.orchestrator.setBlock(b),
        getBlock: (bid) => deps.orchestrator.getBlock(bid),
        removeBlock: (bid) => deps.orchestrator.removeBlock(bid),
        listBlocks: () => deps.orchestrator.listBlocks(),
        log: (msg) => log.info("[" + id + "] " + msg),
      };

      // e. Register the plugin.
      await plugin.setup(ctx);
      loaded.push({ plugin, ctx });
    }
  }

  async function teardown(): Promise<void> {
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

  return { load, teardown };
}
