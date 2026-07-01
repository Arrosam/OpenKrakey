/**
 * Tool-name encoding for provider-legal function-calling.
 *
 * OpenAI's function-calling spec — enforced by OpenAI, DeepSeek, and Anthropic's
 * cloud APIs — requires tool/function names to match `^[a-zA-Z0-9_-]+$` (no dots).
 * Krakey action names are dotted (e.g. "web-chat.send_message", "log.fetch"), so
 * every tool call 400s on strict providers.
 *
 * This builds a collision-free, bidirectional map for ONE request's tool list:
 *   encode(orig) -> wire   (sanitize disallowed chars to "_"; disambiguate clashes)
 *   decode(wire) -> orig   (returned tool_call name back to the dotted action)
 *
 * The map is purely internal to the gateway adapters — no contract changes. The
 * orchestrator still receives the original dotted action name and dispatches it.
 */
import type { ToolDef } from "../../../../contracts/llm";

/** Already provider-legal? (`^[a-zA-Z0-9_-]+$`, non-empty) */
const LEGAL = /^[a-zA-Z0-9_-]+$/;

/** Deterministically sanitize any name to the provider-legal character set. */
function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export interface ToolNameMap {
  /** Original (possibly dotted) name -> provider-legal wire name. */
  encode(orig: string): string;
  /** Wire name -> original name. Unknown names pass through unchanged. */
  decode(wire: string): string;
}

/**
 * Build a collision-free bidirectional name map from a request's tool list.
 *
 * Forward rule: a name already matching `^[a-zA-Z0-9_-]+$` is unchanged; otherwise
 * disallowed chars become "_". If two DISTINCT originals would collide on the same
 * wire name (e.g. "a.b" and "a_b"), the later one is disambiguated with a "_2",
 * "_3", … suffix so distinct originals always stay distinct on the wire.
 */
export function buildToolNameMap(tools: ToolDef[] | undefined): ToolNameMap {
  const fwd = new Map<string, string>(); // orig -> wire
  const rev = new Map<string, string>(); // wire -> orig
  const used = new Set<string>(); // claimed wire names

  for (const t of tools ?? []) {
    const orig = t.name;
    // A duplicate ToolDef name maps to the already-assigned wire name.
    if (fwd.has(orig)) continue;

    let wire = LEGAL.test(orig) ? orig : sanitize(orig);
    if (used.has(wire)) {
      // Distinct original collided with an existing wire name — disambiguate.
      let n = 2;
      while (used.has(`${wire}_${n}`)) n++;
      wire = `${wire}_${n}`;
    }

    fwd.set(orig, wire);
    rev.set(wire, orig);
    used.add(wire);
  }

  return {
    encode(orig: string): string {
      const known = fwd.get(orig);
      if (known !== undefined) return known;
      // Never-declared name (defensive): sanitize deterministically.
      return LEGAL.test(orig) ? orig : sanitize(orig);
    },
    decode(wire: string): string {
      const orig = rev.get(wire);
      // Unknown / never-sent name: return as-is rather than throwing.
      return orig !== undefined ? orig : wire;
    },
  };
}
