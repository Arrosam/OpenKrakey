import type { TranscriptEntry } from "./transcript-store";

/**
 * Select the entries to render into the LLM prompt from the full transcript
 * (oldest→newest). Keeps at most the last `maxTurns` entries, then drops the
 * oldest of those until the cumulative text length is within `maxChars` — always
 * keeping at least the newest entry even if it alone exceeds maxChars. Returns
 * the kept entries in chronological order. Never mutates input; never clips a
 * single entry's text (entry granularity only).
 */
export function windowTranscript(
  entries: readonly TranscriptEntry[],
  maxTurns: number,
  maxChars: number,
): readonly TranscriptEntry[] {
  if (entries.length === 0) return [];
  const candidates =
    entries.length > maxTurns ? entries.slice(entries.length - maxTurns) : entries;
  let cumLen = candidates[candidates.length - 1].text.length;
  let firstKeptIdx = candidates.length - 1; // always keep the newest
  for (let i = candidates.length - 2; i >= 0; i--) {
    const next = cumLen + candidates[i].text.length;
    if (next > maxChars) break;
    cumLen = next;
    firstKeptIdx = i;
  }
  return candidates.slice(firstKeptIdx);
}
