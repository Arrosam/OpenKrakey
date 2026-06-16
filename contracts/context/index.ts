/**
 * Contract: context  ·  connects: orchestrator (owns the buffer), loader (PluginContext)
 *
 * Data shapes for context blocks. There is NO context-buffer node — the buffer
 * lives inside the orchestrator. Blocks are composed by `priority` DESCENDING
 * (higher = rendered/placed first, i.e. at the TOP). Convention: fixed/stable
 * blocks (identity, system prompt) use HIGH priority (10000+) so the stable
 * prefix sits on top (good for prompt caching); volatile blocks (conversation,
 * tool-use results) use LOW priority (0–10000) below.
 *
 * ENCAPSULATION: when the orchestrator composes the full context it wraps each
 * block's rendered text in a labelled delimiter — `<label>\n…\n</label>` — so every
 * plugin's contribution is a clearly-bounded block in the prompt. A plugin nominates
 * the wrapper via `ContextBlock.label`; when omitted the block's `id` is used. A block
 * that renders to "" (including a render that throws) contributes nothing at all.
 */
export interface ContextBlock {
  id: string;
  /** Higher = placed/rendered first (top). Fixed ≈ 10000+, volatile 0–10000. */
  priority: number;
  /**
   * Label the orchestrator wraps this block's rendered text in (`<label>…</label>`)
   * when composing the context, naming the block in the prompt independently of its
   * addressing `id`. Defaults to `id` when omitted.
   */
  label?: string;
  render(): string | Promise<string>;
}

/** The full context snapshot sent to the LLM for one beat. */
export interface ComposedContext {
  text: string;
  meta?: Record<string, unknown>;
}
