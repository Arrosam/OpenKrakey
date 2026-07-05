/**
 * loader — per-Agent plugin lifecycle.
 *
 * Resolves this Agent's plugins (copy declared independents into the agent's
 * private folder, auto-load that folder which overrides same-id public, then
 * load declared public plugins), builds each plugin's PluginContext, and
 * registers it via `setup`. `teardown` tears every loaded plugin down in
 * reverse load order. The loader does NOT run the frame.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

import type { Loader } from "../../../contracts/loader";
import type { Plugin, PluginContext } from "../../../contracts/plugin";
import type { EventSystem, EventBus, ActionBus, Unsub } from "../../../contracts/event-system";
import type { Orchestrator } from "../../../contracts/orchestrator";
import type { AgentDefinition } from "../../../contracts/agent";
import type { CommunicatorLibrary } from "../../../contracts/llm";
import { PluginLoadError } from "../../../shared/errors";
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

  /**
   * Mirror one plugin console line onto this Agent's own bus (Events.LOG).
   * Re-entrancy guard: Events.LOG fans out synchronously, so a `log.entry`
   * subscriber that calls ctx.log.* would recurse forever (ctx.log →
   * pushLogEntry → emit → handler → ctx.log → …). The flag is only true during
   * a single synchronous fan-out, so sequential logs still each emit; only a
   * log triggered from inside a log.entry handler is dropped.
   */
  let emittingLog = false;
  const pushLogEntry = (
    level: "info" | "warn" | "error" | "print",
    pluginId: string,
    text: string,
  ): void => {
    if (emittingLog) return;
    emittingLog = true;
    try {
      deps.events.events.emit(Events.LOG, {
        at: Date.now(),
        data: { level, pluginId, text },
      });
    } finally {
      emittingLog = false;
    }
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
    //    factory), collecting the full load set before any setup runs. A plugin
    //    whose import/instantiation throws is SKIPPED (not rethrown): warn on both
    //    sinks (naming the id + underlying error) and drop it from the load set —
    //    its siblings still load (skip-and-continue).
    const skipped = new Set<string>();
    const loadSet: Array<{ id: string; plugin: Plugin; dataDir: string }> = [];
    for (const [id, { codeDir, dataDir }] of resolved) {
      let plugin: Plugin;
      try {
        plugin = await importPlugin(id, codeDir);
      } catch (err) {
        const detail = "plugin '" + id + "' failed to import and will be SKIPPED: " + err;
        log.warn(detail);
        pushLogEntry("warn", "core:loader", detail);
        skipped.add(id);
        continue;
      }
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

    // 4. PASS 2 — set up plugins, choosing an order that SATISFIES `requires`.
    //    A `requires` entry with a dot is an ACTION that must be on the actionbus
    //    by an EARLIER plugin's setup (order-dependent); any other entry must be a
    //    plugin id or `provides` capability anywhere in the load set (order-
    //    independent, checked against `available`). Rather than trust the declared
    //    array order — which the config tools can't always get right for action
    //    deps — we repeatedly set up the EARLIEST not-yet-set-up plugin whose
    //    requirements are ALL currently met; setting it up may register the actions
    //    that unblock others. Declared order is preserved among plugins ready
    //    together, so independents keep their order. If a full scan finds nothing
    //    ready while plugins remain, the leftover deps are genuinely unsatisfiable
    //    (a cycle, a skipped/missing provider) — SKIP the first still-pending plugin
    //    (warn, naming the id + the unmet requirement) and re-sweep; cascades resolve
    //    one plugin at a time. A plugin whose setup() throws is likewise SKIPPED, not
    //    rolled back — plugins already set up STAY UP (skip-and-continue).
    const isMet = (req: string): boolean =>
      req.includes(".") ? deps.events.actions.has(req) : available.has(req);
    const firstUnmet = (plugin: Plugin): string | undefined =>
      (plugin.manifest.requires ?? []).find((req) => !isMet(req));

    // Build the PluginContext for one plugin and run its setup. Every mutating
    // surface a plugin touches through its ctx is TRACKED so that, if its setup()
    // throws AFTER a partial registration, we can UNDO exactly that plugin's
    // side-effects before the sweep continues — otherwise a leaked action/listener
    // would falsely satisfy a dependent's `requires` (and a half-initialized
    // handler could later run against never-finished state). Tracking is a few
    // cheap closures per plugin; on success nothing is undone.
    const setUp = async (id: string, plugin: Plugin, dataDir: string): Promise<void> => {
      const unsubs: Unsub[] = [];
      const blockIds = new Set<string>();
      // Thin pass-throughs to the real buses that also collect the Unsub each
      // register/on returns; all other bus methods delegate unchanged.
      const trackedActions: ActionBus = {
        register: (action, handler) => {
          const unsub = deps.events.actions.register(action, handler);
          unsubs.push(unsub);
          return unsub;
        },
        invoke: (action, params) => deps.events.actions.invoke(action, params),
        has: (action) => deps.events.actions.has(action),
        list: () => deps.events.actions.list(),
      };
      const trackedEvents: EventBus = {
        emit: (event, payload) => deps.events.events.emit(event, payload),
        on: (event, handler) => {
          const unsub = deps.events.events.on(event, handler);
          unsubs.push(unsub);
          return unsub;
        },
      };
      const ctx: PluginContext = {
        agentId: deps.agentId,
        events: trackedEvents,
        actions: trackedActions,
        config: deps.def.config?.[id] ?? {},
        dataDir,
        llm: deps.library,
        // Remember blocks this plugin adds (balance against its own removes) so
        // an undo removes only blocks it still owns, never another plugin's.
        setBlock: (b) => {
          blockIds.add(b.id);
          deps.orchestrator.setBlock(b);
        },
        getBlock: (bid) => deps.orchestrator.getBlock(bid),
        removeBlock: (bid) => {
          blockIds.delete(bid);
          return deps.orchestrator.removeBlock(bid);
        },
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
      try {
        await plugin.setup(ctx);
      } catch (err) {
        // Partial registration is now undone (each op isolated) BEFORE we return
        // to the sweep — so the leaked action/listener is gone before any
        // dependent's readiness is re-evaluated. We do NOT call the plugin's own
        // teardown(): a plugin that threw mid-setup is in an undefined state.
        for (const unsub of unsubs) {
          try {
            unsub();
          } catch {
            // isolated — a failed unsub must not abort the rest of the undo
          }
        }
        for (const bid of blockIds) {
          try {
            deps.orchestrator.removeBlock(bid);
          } catch {
            // isolated — see above
          }
        }
        throw err;
      }
      loaded.push({ plugin, ctx });
    };

    const pending = [...loadSet];
    while (pending.length > 0) {
      // Earliest plugin (declared order) whose requirements are ALL met now.
      const idx = pending.findIndex(({ plugin }) => firstUnmet(plugin) === undefined);
      if (idx === -1) {
        // Nothing can make progress — a cycle, or a provider that was skipped /
        // never declared. Skip the FIRST still-pending plugin (naming the id + the
        // specific unmet requirement) and re-sweep; a dependent of a skipped
        // provider is skipped on a later pass, one plugin at a time. This
        // converges in <= pending.length passes.
        const { id, plugin } = pending.shift()!;
        const req = firstUnmet(plugin);
        const detail =
          "plugin '" + id + "' requires '" + req + "' which no loaded plugin provides — SKIPPED";
        log.warn(detail);
        pushLogEntry("warn", "core:loader", detail);
        skipped.add(id);
        continue;
      }
      const { id, plugin, dataDir } = pending.splice(idx, 1)[0];
      try {
        await setUp(id, plugin, dataDir);
      } catch (err) {
        // setup() threw/rejected: SKIP this plugin (it is NOT pushed into
        // loaded[], so its never-run teardown is never invoked) and CONTINUE —
        // plugins already set up stay up (no rollback).
        const detail = "plugin '" + id + "' failed to set up and will be SKIPPED: " + err;
        log.warn(detail);
        pushLogEntry("warn", "core:loader", detail);
        skipped.add(id);
      }
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
