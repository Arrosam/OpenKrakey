/**
 * Plugin: notes — a persistent named-note store under the plugin's `dataDir`.
 *
 * Single job: let the LLM (or any plugin) save / read / list markdown notes as
 * files. Each note is one `<dataDir>/notes/<name>.md`. Names are validated to a
 * safe charset so a note name can never escape the notes directory. The three
 * operations are exposed both as actionbus actions and as LLM tools (registered
 * via the `llm.register_tool` action), so the model can call them as tools.
 *
 * dataDir follows the plugin's install location: public ⇒ one library shared by
 * all agents; independent copy ⇒ a private library per agent.
 *
 * The default export is a PluginFactory — the loader calls it once per Agent,
 * so the Unsubs live in this closure, never in shared module scope.
 */
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import type { Unsub } from "../../contracts/event-system";
import type { ToolDef } from "../../contracts/llm";

/** Allowed note-name charset; `.`/`..` are additionally rejected. */
const NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Validate an untrusted note name and return it. Throws (before any filesystem
 * access) on a missing/non-string name, a disallowed character, or `.`/`..` —
 * guaranteeing the resolved path stays inside the notes directory.
 */
function validateName(name: unknown): string {
  if (typeof name !== "string" || !NAME_RE.test(name) || name === "." || name === "..") {
    throw new Error(`invalid note name: ${JSON.stringify(name)}`);
  }
  return name;
}

const createNotes: PluginFactory = (): Plugin => {
  /** Action Unsubs captured at setup, released in teardown. */
  let unsubs: Unsub[] = [];

  return {
    manifest: { id: "notes", version: "0.1.0", requires: ["llm.register_tool"] },

    async setup(ctx: PluginContext): Promise<void> {
      const notesDir = join(ctx.dataDir, "notes");
      mkdirSync(notesDir, { recursive: true });

      const pathFor = (name: string) => join(notesDir, `${name}.md`);

      unsubs = [
        ctx.actions.register("note.save", async (params) => {
          const { name, text } = (params ?? {}) as { name?: unknown; text?: unknown };
          const safe = validateName(name);
          if (typeof text !== "string") {
            throw new Error("note text must be a string");
          }
          writeFileSync(pathFor(safe), text, "utf8");
          return { saved: true, name: safe };
        }),

        ctx.actions.register("note.read", async (params) => {
          const { name } = (params ?? {}) as { name?: unknown };
          const safe = validateName(name);
          let text: string;
          try {
            text = readFileSync(pathFor(safe), "utf8");
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              throw new Error(`note not found: ${safe}`);
            }
            throw err;
          }
          return { name: safe, text };
        }),

        ctx.actions.register("note.list", async () => {
          const names = readdirSync(notesDir)
            .filter((f) => f.endsWith(".md"))
            .map((f) => f.slice(0, -".md".length))
            .sort();
          return { names };
        }),
      ];

      // Declare each operation as an LLM tool. If the action is absent in some
      // exotic setup the invoke rejects — the actions above still work, so log
      // and continue rather than failing setup.
      const tools: ToolDef[] = [
        {
          name: "note.save",
          description: "Save a named note's text to the shared notes library, creating or overwriting it.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Note name (letters, digits, '.', '_', '-')." },
              text: { type: "string", description: "The note body to store." },
            },
            required: ["name", "text"],
          },
        },
        {
          name: "note.read",
          description: "Read a named note's text from the notes library.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Note name to read." },
            },
            required: ["name"],
          },
        },
        {
          name: "note.list",
          description: "List the names of all saved notes.",
          parameters: { type: "object", properties: {} },
        },
      ];

      for (const def of tools) {
        try {
          await ctx.actions.invoke("llm.register_tool", def);
        } catch (err) {
          ctx.log.warn(`notes: could not register tool ${def.name}: ${String(err)}`);
        }
      }
    },

    teardown(): void {
      for (const off of unsubs) off();
      unsubs = [];
    },
  };
};

export default createNotes;
