/**
 * Plugin: history — conversation memory.
 *
 * Folds the agent's dialogue into a single bounded, low-priority context block so
 * every beat sees the conversation so far, and mirrors each new line to
 * `<dataDir>/history.jsonl` so the memory survives restarts. It listens for three
 * generic events — user input, the LLM's return (with its tool calls), and each
 * settled tool result — rendering every one to a flat text line. Public install =
 * shared memory across agents; private install = agent-isolated.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent, so
 * the entries and Unsubs live in this closure, never in shared module scope.
 */
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type { LLMResponse, ToolCall } from "../../contracts/llm";
import {
  Events,
  type Notify,
  type Reply,
} from "../../shared/actions";

const BLOCK_ID = "history";
const DEFAULT_MAX_ENTRIES = 200;

type EntryKind = "user" | "assistant" | "tool_call" | "tool_result";

/** One persisted line: the rendered `text` IS the stored payload. */
interface Entry {
  at: number;
  kind: EntryKind;
  text: string;
}

/** `tool.result` is a Reply carrying the tool name. */
type ToolResult = Reply<unknown> & { name: string };

const createHistory: PluginFactory = (): Plugin => {
  let context: PluginContext | undefined;
  let unsubs: Unsub[] = [];

  return {
    manifest: { id: "history", version: "0.1.0" },

    setup(ctx: PluginContext) {
      context = ctx;
      const cfg = (ctx.config ?? {}) as { maxEntries?: number };
      const maxEntries =
        typeof cfg.maxEntries === "number" && cfg.maxEntries > 0
          ? cfg.maxEntries
          : DEFAULT_MAX_ENTRIES;

      const file = join(ctx.dataDir, "history.jsonl");
      mkdirSync(ctx.dataDir, { recursive: true });

      // Re-render previously persisted entries (memory across restarts), keeping
      // only the LAST maxEntries; unparseable lines are skipped, never fatal.
      const entries: Entry[] = [];
      try {
        const raw = readFileSync(file, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            entries.push(JSON.parse(line) as Entry);
          } catch {
            // skip malformed line
          }
        }
      } catch {
        // no file yet — start empty
      }
      if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);

      /** Append one entry to memory (trim from the front) and to the JSONL file. */
      const record = (kind: EntryKind, text: string) => {
        const entry: Entry = { at: Date.now(), kind, text };
        entries.push(entry);
        if (entries.length > maxEntries) entries.shift();
        appendFileSync(file, JSON.stringify(entry) + "\n");
      };

      // user input → "user: <text>"
      unsubs.push(
        ctx.events.on(Events.INPUT_MESSAGE, (payload: unknown) => {
          const data = (payload as Notify<{ text?: unknown }> | undefined)?.data;
          if (typeof data?.text === "string") record("user", `user: ${data.text}`);
        })
      );

      // llm.return → "assistant: <content>" (+ one tool_call line per tool call)
      unsubs.push(
        ctx.events.on(Events.LLM_RETURN, (payload: unknown) => {
          const reply = payload as Reply<LLMResponse> | undefined;
          if (!reply?.ok || !reply.data) return;
          record("assistant", `assistant: ${reply.data.content}`);
          const calls: ToolCall[] = reply.data.toolCalls ?? [];
          for (const call of calls) {
            record(
              "tool_call",
              `assistant -> tool: ${call.name}(${JSON.stringify(call.arguments)})`
            );
          }
        })
      );

      // tool.result → "tool <name> -> <data>" (ok) | "tool <name> !! <error>" (failure)
      unsubs.push(
        ctx.events.on(Events.TOOL_RESULT, (payload: unknown) => {
          const res = payload as ToolResult | undefined;
          if (!res || typeof res.name !== "string") return;
          record(
            "tool_result",
            res.ok
              ? `tool ${res.name} -> ${JSON.stringify(res.data)}`
              : `tool ${res.name} !! ${res.error}`
          );
        })
      );

      ctx.setBlock({
        id: BLOCK_ID,
        priority: 100,
        render: () =>
          "## Conversation" +
          (entries.length ? "\n" + entries.map((e) => e.text).join("\n") : ""),
      });
    },

    teardown() {
      context?.removeBlock(BLOCK_ID);
      context = undefined;
      for (const off of unsubs) off();
      unsubs = [];
    },
  };
};

export default createHistory;
