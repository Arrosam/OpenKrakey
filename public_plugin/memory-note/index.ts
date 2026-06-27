/**
 * memory-note — Krakey's private long-term notebook.
 *
 * Two tools (memory-note.remember / memory-note.forget) record and drop notes;
 * they persist per-agent and the WHOLE notebook is re-rendered into context every
 * frame (the <memory-note> section) so the agent keeps it in mind. Writes are
 * synchronous within the frame and the notes block is the feedback — there is no
 * tool.result loop and no clock.fire_now.
 *
 * Allowed imports only: ../../contracts/*, ../../shared/*, Node builtins, and own
 * ./ siblings (R2). All mutable state lives in the factory closure (R6).
 */
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type { ToolDef } from "../../contracts/llm";

import { MEMORY_NOTE_SCHEMA } from "./config-schema";
import { KINDS, guidanceText, readConfig, renderNotes } from "./notes";
import type { NoteKind } from "./notes";
import { NotesStore } from "./notes-store";

const KIND_SET = new Set<string>(KINDS);
const GUIDANCE_BLOCK = "memory-note.guidance";
const NOTES_BLOCK = "memory-note.notes";

/** Validate + coerce the params of memory-note.remember. Throws on bad input. */
function parseRemember(params: unknown): { text: string; kind: NoteKind; importance: number } {
  const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};

  if (typeof p.note !== "string" || p.note.trim() === "") {
    throw new Error("memory-note.remember: 'note' must be a non-empty string.");
  }

  let kind: NoteKind = "thought";
  if (p.kind !== undefined) {
    if (typeof p.kind !== "string" || !KIND_SET.has(p.kind)) {
      throw new Error(
        "memory-note.remember: 'kind' must be one of goal | keep-in-mind | thought | finding.",
      );
    }
    kind = p.kind as NoteKind;
  }

  let importance = 3;
  if (typeof p.importance === "number" && Number.isFinite(p.importance)) {
    importance = Math.min(5, Math.max(1, Math.round(p.importance)));
  }

  return { text: p.note, kind, importance };
}

const createMemoryNote: PluginFactory = (): Plugin => {
  // ── per-Agent state lives HERE, in the closure (R6) ──
  let unsubs: Unsub[] = [];
  let store: NotesStore | null = null;
  let context: PluginContext | null = null;
  let torn = false;

  return {
    manifest: {
      id: "memory-note",
      version: "0.1.0",
      requires: ["llm.register_tool"],
      configSchema: MEMORY_NOTE_SCHEMA,
    },

    async setup(ctx: PluginContext): Promise<void> {
      torn = false;
      context = ctx;
      const cfg = readConfig(ctx.config);

      store = new NotesStore(ctx.dataDir, cfg);
      store.load();

      // ---- actions ----
      const offRemember = ctx.actions.register("memory-note.remember", async (params) => {
        const input = parseRemember(params); // throws → orchestrator reports ok:false
        return store!.remember(input);
      });

      const offForget = ctx.actions.register("memory-note.forget", async (params) => {
        const p = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
        if (typeof p.id !== "string" || p.id === "") {
          throw new Error("memory-note.forget: 'id' must be a non-empty string.");
        }
        return store!.forget(p.id);
      });

      unsubs.push(offRemember, offForget);

      // ---- tool declarations (best-effort) ----
      const rememberDef: ToolDef = {
        name: "memory-note.remember",
        description:
          "Save a note to your private long-term notebook (a goal, a keep-in-mind, a thought, " +
          "or a finding) with an importance from 1 to 5. The notebook is always shown to you in " +
          "the <memory-note> context section — this tool does not return its content inline. The " +
          "notebook is capped and DROPS THE LEAST-IMPORTANT note when full, so set importance honestly.",
        parameters: {
          type: "object",
          properties: {
            note: { type: "string", description: "The note text to remember." },
            kind: {
              type: "string",
              enum: ["goal", "keep-in-mind", "thought", "finding"],
              description: "What kind of note this is. Default 'thought'.",
            },
            importance: {
              type: "number",
              minimum: 1,
              maximum: 5,
              description: "How important this note is, 1 (minor) to 5 (critical). Default 3.",
            },
          },
          required: ["note"],
        },
      };

      const forgetDef: ToolDef = {
        name: "memory-note.forget",
        description:
          "Drop a note from your private long-term notebook by its id (e.g. 'g3'). The notebook " +
          "is always shown to you in the <memory-note> context section — this tool does not return " +
          "content inline; the note simply disappears from that section next frame.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "The id of the note to forget (e.g. 'g3', 't12')." },
          },
          required: ["id"],
        },
      };

      for (const def of [rememberDef, forgetDef]) {
        try {
          await ctx.actions.invoke("llm.register_tool", def);
        } catch (err) {
          ctx.log.warn(`memory-note: failed to register tool ${def.name}: ${String(err)}`);
        }
      }

      // ---- context blocks ----
      ctx.setBlock({
        id: GUIDANCE_BLOCK,
        label: GUIDANCE_BLOCK,
        target: "system",
        priority: cfg.guidancePriority,
        render: () => guidanceText(cfg),
      });

      ctx.setBlock({
        id: NOTES_BLOCK,
        label: "memory-note",
        target: "system",
        priority: cfg.notesPriority,
        render: () => {
          try {
            return renderNotes(store ? store.list() : [], cfg);
          } catch {
            return "";
          }
        },
      });

      ctx.print("memory-note: notebook ready");
    },

    teardown(): void {
      if (torn) return; // idempotent: a second call is a safe no-op
      torn = true;

      for (const off of unsubs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      unsubs = [];

      if (context) {
        try {
          context.removeBlock(GUIDANCE_BLOCK);
        } catch {
          /* ignore */
        }
        try {
          context.removeBlock(NOTES_BLOCK);
        } catch {
          /* ignore */
        }
        context = null;
      }

      if (store) {
        store.flushSync();
        store = null;
      }
    },
  };
};

export default createMemoryNote;
