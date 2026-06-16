/**
 * Plugin: history — conversation memory in Hermes chat-history shape.
 *
 * Instead of one flat text block, history keeps the dialogue as an ordered list of
 * ROLE-SEPARATED turns — user / assistant (+ its toolCalls) / tool (+ its toolCallId)
 * — each carrying provenance (`source`) and a timestamp (`at`). It folds three generic
 * events into turns: user input, the LLM's return, and each settled tool result; and
 * persists every turn to `<dataDir>/history.jsonl` so memory survives restarts. On every
 * `prompt.gather` it CONTRIBUTES the current conversation to the orchestrator by emitting
 * `conversation.snapshot` as wire-ready `Message[]` (provenance `at`/`source` stripped),
 * which the orchestrator forwards as the beat's `llm.request` messages. Public install =
 * shared memory across agents; private install = agent-isolated.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent, so the
 * turns and Unsubs live in this closure, never in shared module scope.
 */
import { mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type { LLMResponse, Message, ToolCall } from "../../contracts/llm";
import {
  Events,
  type ConversationMessage,
  type Notify,
  type Reply,
} from "../../shared/actions";

const DEFAULT_MAX_ENTRIES = 200;
const ROLES = new Set(["user", "assistant", "tool"]);

/** `tool.result` is a Reply carrying the tool name (its `id` = the ToolCall id). */
type ToolResult = Reply<unknown> & { name: string };

/** A reloaded JSONL line is only a usable turn if it has a known role + string content. */
function isTurn(x: unknown): x is ConversationMessage {
  return (
    !!x &&
    typeof x === "object" &&
    ROLES.has((x as ConversationMessage).role) &&
    typeof (x as ConversationMessage).content === "string"
  );
}

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

      // Re-load previously persisted turns (memory across restarts), keeping only
      // the LAST maxEntries; unparseable lines are skipped, never fatal.
      const turns: ConversationMessage[] = [];
      try {
        const raw = readFileSync(file, "utf8");
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          try {
            const turn = JSON.parse(line) as ConversationMessage;
            // A corrupt or foreign-schema line must never poison the conversation.
            if (isTurn(turn)) turns.push(turn);
          } catch {
            // skip malformed line
          }
        }
      } catch {
        // no file yet — start empty
      }
      if (turns.length > maxEntries) turns.splice(0, turns.length - maxEntries);

      /** Append one turn to memory (trim from the front) and to the JSONL file. */
      const record = (turn: ConversationMessage) => {
        turns.push(turn);
        if (turns.length > maxEntries) turns.shift();
        appendFileSync(file, JSON.stringify(turn) + "\n");
      };

      // user input → a user turn; source = the input channel (e.g. "web").
      unsubs.push(
        ctx.events.on(Events.INPUT_MESSAGE, (payload: unknown) => {
          const note = payload as
            | Notify<{ text?: unknown; channel?: unknown }>
            | undefined;
          const text = note?.data?.text;
          if (typeof text !== "string") return;
          const source =
            typeof note?.data?.channel === "string" ? note.data.channel : "user";
          record({
            role: "user",
            content: text,
            name: source,
            source,
            at: typeof note?.at === "number" ? note.at : Date.now(),
          });
        }),
      );

      // llm.return → an assistant turn (content + any toolCalls); source = "assistant".
      unsubs.push(
        ctx.events.on(Events.LLM_RETURN, (payload: unknown) => {
          const reply = payload as Reply<LLMResponse> | undefined;
          if (!reply?.ok || !reply.data) return;
          const turn: ConversationMessage = {
            role: "assistant",
            content:
              typeof reply.data.content === "string" ? reply.data.content : "",
            source: "assistant",
            at: typeof reply.at === "number" ? reply.at : Date.now(),
          };
          const calls: ToolCall[] = reply.data.toolCalls ?? [];
          if (calls.length > 0) turn.toolCalls = calls;
          record(turn);
        }),
      );

      // tool.result → a tool turn (toolCallId = the call id, name = the tool);
      // source = the tool name.
      unsubs.push(
        ctx.events.on(Events.TOOL_RESULT, (payload: unknown) => {
          const res = payload as ToolResult | undefined;
          if (!res || typeof res.name !== "string") return;
          record({
            role: "tool",
            content: res.ok
              ? JSON.stringify(res.data ?? null)
              : `Error: ${res.error ?? "tool failed"}`,
            toolCallId: res.id,
            name: res.name,
            source: res.name,
            at: typeof res.at === "number" ? res.at : Date.now(),
          });
        }),
      );

      // On every gather, contribute the current conversation to the orchestrator as
      // wire-ready Message[] — strip provenance (at/source); a user turn's source is
      // already surfaced via Message.name. The orchestrator captures this snapshot
      // and forwards it as the beat's llm.request messages.
      unsubs.push(
        ctx.events.on(Events.PROMPT_GATHER, () => {
          const messages: Message[] = turns.map(({ at, source, ...m }) => m);
          const snap: Notify<{ messages: Message[] }> = {
            at: Date.now(),
            data: { messages },
          };
          ctx.events.emit(Events.CONVERSATION_SNAPSHOT, snap);
        }),
      );
    },

    teardown() {
      for (const off of unsubs) off();
      unsubs = [];
      context = undefined;
    },
  };
};

export default createHistory;
