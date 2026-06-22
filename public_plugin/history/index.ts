// public_plugin/history/index.ts — per-agent, persisted, compacting tool-use log.
//
// AUTO-CAPTURES the bus `tool.result` event (every tool, all plugins) and ALSO
// exposes a `history.record` action other plugins may push entries to. It renders
// a compacted trail into the system context, persists per-agent, and DISTILLS a
// checkpoint note into memory-note when it compacts. It authors nothing on its own.
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import { Events } from "../../shared/actions";
import { HISTORY_SCHEMA } from "./config-schema";
import { readConfig, summarize, renderLog, type Entry } from "./history";
import { HistoryStore, type RecordInput } from "./history-store";

const createHistory: PluginFactory = (): Plugin => {
  // ── all mutable state lives in this closure (R6) ──
  let unsubs: Array<Unsub> = [];
  let torn = false;
  // Bound at setup so teardown can undo block/store work without `this`.
  let removeLog: (() => void) | null = null;

  return {
    manifest: {
      id: "history",
      version: "0.1.0",
      // history depends on memory-note: the loader guarantees this action is
      // registered before our setup runs (memory-note loads first).
      requires: ["memory-note.remember"],
      configSchema: HISTORY_SCHEMA,
    },

    async setup(ctx: PluginContext): Promise<void> {
      const cfg = readConfig(ctx.config);
      const store = new HistoryStore(ctx.dataDir, cfg);
      store.load();

      // Best-effort distillation of a dropped batch into memory-note. Never throws.
      const distill = (batch: Entry[]): void => {
        const sources = summarize(batch.map((e) => e.source).join(", "), 400);
        const note = `History checkpoint — ${batch.length} tool actions: ${sources}`;
        ctx.actions
          .invoke("memory-note.remember", {
            note,
            kind: "finding",
            importance: cfg.noteImportance,
          })
          .catch(() => {});
      };

      // Single funnel for both auto-capture and the action: record + maybe distill.
      const record = (input: RecordInput): Entry => {
        const { entry, dropped } = store.record(input);
        if (dropped.length) distill(dropped);
        return entry;
      };

      // 1) Auto-capture every tool.result on the bus (all plugins) — listener never throws.
      if (cfg.captureToolResults) {
        const offResult = ctx.events.on(Events.TOOL_RESULT, (payload) => {
          if (!payload || typeof payload !== "object") return;
          const p = payload as {
            name?: unknown;
            ok?: unknown;
            data?: unknown;
            error?: unknown;
            at?: unknown;
          };
          if (typeof p.name !== "string" || p.name.length === 0) return;
          const ok = !!p.ok;
          record({
            source: p.name,
            kind: "tool_result",
            ok,
            text: summarize(ok ? p.data : p.error, cfg.maxEntryChars),
            at: typeof p.at === "number" ? p.at : Date.now(),
          });
        });
        unsubs.push(offResult);
      }

      // 2) `history.record` — let other plugins push entries explicitly.
      const offAction = ctx.actions.register("history.record", async (params: unknown) => {
        const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
        if (typeof p.source !== "string" || p.source.length === 0) {
          throw new Error("history.record: 'source' must be a non-empty string");
        }
        if (typeof p.text !== "string" || p.text.trim() === "") {
          throw new Error("history.record: 'text' must be a non-empty string");
        }
        if (p.kind !== undefined && typeof p.kind !== "string") {
          throw new Error("history.record: 'kind' must be a string when provided");
        }
        if (p.ok !== undefined && typeof p.ok !== "boolean") {
          throw new Error("history.record: 'ok' must be a boolean when provided");
        }
        if (p.at !== undefined && typeof p.at !== "number") {
          throw new Error("history.record: 'at' must be a number when provided");
        }
        const entry = record({
          source: p.source,
          text: p.text,
          kind: typeof p.kind === "string" ? p.kind : "note",
          ok: p.ok as boolean | undefined,
          at: p.at as number | undefined,
        });
        return { id: entry.id };
      });
      unsubs.push(offAction);

      // 3) The rendered log block — newest-first, isolated (render never throws).
      ctx.setBlock({
        id: "history.log",
        label: "history",
        target: "system",
        priority: cfg.logPriority,
        render: (): string => {
          try {
            return renderLog(store.list(), cfg);
          } catch {
            return "";
          }
        },
      });

      // Bind the block/store cleanup into the closure for teardown.
      removeLog = (): void => {
        ctx.removeBlock("history.log");
        store.flushSync();
      };

      ctx.print("history: tool-use log ready");
    },

    teardown(): void {
      // Idempotent: unsubscribe listeners + action, remove block, flush store.
      // A second call (or a call before setup) is a safe no-op.
      if (torn) return;
      torn = true;
      for (const off of unsubs) {
        try {
          off();
        } catch {
          // ignore
        }
      }
      unsubs = [];
      if (removeLog) {
        try {
          removeLog();
        } catch {
          // ignore
        }
        removeLog = null;
      }
    },
  };
};

export default createHistory;
