/**
 * Contract: context  ·  connects: orchestrator (owns the buffer), loader (PluginContext)
 *
 * Data shapes for context blocks. There is NO context-buffer node — the buffer
 * lives inside the orchestrator. Blocks are composed by `priority` DESCENDING
 * (higher = rendered/placed first, i.e. at the TOP). Convention: fixed/stable
 * blocks (identity, system prompt) use HIGH priority (10000+) so the stable
 * prefix sits on top (good for prompt caching); volatile blocks (history,
 * tool-use results) use LOW priority (0–10000) below.
 */
export interface ContextBlock {
  id: string;
  /** Higher = placed/rendered first (top). Fixed ≈ 10000+, volatile 0–10000. */
  priority: number;
  render(): string | Promise<string>;
}

/** The full context snapshot sent to the LLM for one beat. */
export interface ComposedContext {
  text: string;
  meta?: Record<string, unknown>;
}
