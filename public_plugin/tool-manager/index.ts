/**
 * Plugin: tool-manager — the per-Agent tool registry, and nothing else.
 *
 * It owns the set of L1 `ToolDef`s that tool plugins declare, so the round-trip
 * plugin (llm-core) and the tool plugins stay decoupled — neither imports the
 * other; they meet only on the actionbus. It registers two actions:
 *
 *   - `llm.register_tool` { ToolDef }  — add or replace a tool by name. This is the
 *     SAME action name tool plugins already call (it simply lived in llm-core
 *     before), so every `requires: ["llm.register_tool"]` keeps resolving — now to
 *     this plugin. tool-manager `provides` the capability so the loader orders it
 *     ahead of every tool plugin.
 *   - `llm.list_tools` → `ToolDef[]` — a snapshot of the registry. llm-core invokes
 *     this when it assembles each chat request, so tools always reflect the current
 *     set without tool-manager ever knowing about the model.
 *
 * Holds NO LLM strategy: it never talks to a model, composes a prompt, or chooses a
 * communicator. All mutable state lives in the factory closure (one registry per
 * Agent, R6) — never module scope.
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type { ToolDef } from "../../contracts/llm";

const createToolManager: PluginFactory = (): Plugin => {
  // --- per-Agent state (factory closure = one instance per Agent) -----------
  /** ToolDefs declared by tool plugins, keyed by name (re-register replaces). */
  const tools = new Map<string, ToolDef>();
  let unsubs: Unsub[] = [];

  return {
    manifest: {
      id: "tool-manager",
      version: "0.1.0",
      // Other plugins `requires: ["llm.register_tool"]`; declaring it here lets the
      // loader sequence this plugin ahead of every tool plugin.
      provides: ["llm.register_tool"],
    },

    setup(ctx: PluginContext): void {
      // The registration seam: tool plugins call this to declare a ToolDef. Same
      // validation llm-core used to apply, so callers see no behaviour change.
      const offRegister = ctx.actions.register("llm.register_tool", async (params: unknown) => {
        if (
          params === null ||
          typeof params !== "object" ||
          typeof (params as ToolDef).name !== "string" ||
          (params as ToolDef).name.length === 0
        ) {
          throw new Error(
            "llm.register_tool: params must be a ToolDef with a non-empty string `name`",
          );
        }
        const def = params as ToolDef;
        tools.set(def.name, def);
        return true;
      });

      // The read seam: a snapshot of the current registry. A fresh array each call
      // so a caller can never mutate our backing store.
      const offList = ctx.actions.register("llm.list_tools", async () => {
        return [...tools.values()];
      });

      unsubs = [offRegister, offList];
      ctx.print("tool-manager: tool registry ready");
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
      tools.clear();
    },
  };
};

export default createToolManager;
