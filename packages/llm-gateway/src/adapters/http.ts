/**
 * Shared adapter HTTP helper: a fetch wrapped in an AbortController timeout.
 *
 * WHY: the chat/embed/rerank adapters POST via the global `fetch`, which has no
 * built-in deadline. A provider that accepts the connection but never answers (a
 * black-hole endpoint) would leave the request pending forever — and since the
 * orchestrator keeps one round-trip in flight per agent, that one hang stalls the
 * whole agent. Bounding every request turns a hang into a normal FAILURE, which
 * surfaces as `llm.return { ok:false }` so the `retry` plugin can accelerate the
 * next frame and the agent self-heals. Outright failures (refused connection,
 * 4xx/5xx) already error fast; this closes the remaining "hangs forever" case.
 */

/**
 * Default per-request timeout (ms) applied when a communicator doesn't set its own
 * `timeoutMs`. Generous enough not to abort a legitimately slow generation, short
 * enough that a dead endpoint becomes a retry-able failure rather than a forever-hang.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/**
 * `fetch` with a deadline. A `timeoutMs` of 0 (or a non-finite/negative value)
 * disables the timeout entirely — identical to a bare `fetch`, the explicit
 * opt-out. Otherwise the request is aborted after `timeoutMs`, and the rejection
 * is normalized to a clear "request timed out" Error (never a bare AbortError).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number | undefined,
): Promise<Response> {
  if (!timeoutMs || timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Distinguish OUR deadline from any other abort/network error.
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
