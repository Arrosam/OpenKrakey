/**
 * browser plugin · config (PURE — no I/O)
 *
 * Parses the plugin's config slice into a typed, defaulted BrowserConfig and
 * provides the pure text helpers the plugin uses (guidance text, truncation,
 * screenshot-name sanitizing, the result ring, and the message renderer).
 *
 * Everything here is deterministic and side-effect free so it is unit-testable
 * without launching Chrome.
 */
import type { Message } from "../../contracts/llm";

export interface BrowserConfig {
  chromePath: string | null;
  headless: boolean;
  headlessMode: "new" | "old" | "off";
  headlessModePinned: boolean;
  remoteDebugPort: number;
  navigationTimeoutMs: number;
  commandTimeoutMs: number;
  maxTextChars: number;
  screenshotDir: string | null;
  guidance: string | null;
  guidancePriority: number;
  resultsPriority: number;
  maxResults: number;
  maxResultChars: number;
  maxResultsTotalChars: number;
  maxFailureNotices: number;
}

const DEFAULTS: BrowserConfig = {
  chromePath: null,
  headless: true,
  headlessMode: "new",
  headlessModePinned: false,
  remoteDebugPort: 0,
  navigationTimeoutMs: 30000,
  commandTimeoutMs: 10000,
  maxTextChars: 50000,
  screenshotDir: null,
  guidance: null,
  guidancePriority: 5500,
  resultsPriority: 3000,
  maxResults: 10,
  maxResultChars: 4000,
  maxResultsTotalChars: 16000,
  maxFailureNotices: 8,
};

/** A nullable string field: use the value only if it is a string, else default null. */
function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** A finite number field: use the value only if it is a finite number, else the default. */
function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A boolean field: use the value only if it is a boolean, else the default. */
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Resolve the effective headless mode + whether the operator pinned it.
 *
 * Precedence:
 *  1. A VALID explicit headlessMode ("new"|"old"|"off") wins → pinned = true.
 *  2. Any other headlessMode value (invalid / wrong-typed) is ignored entirely
 *     — treated as absent for both value and pinned.
 *  3. Fall-through: legacy `headless === false` → "off"; otherwise "new".
 *     These fall-throughs are never pinned.
 */
function resolveHeadlessMode(
  rawMode: unknown,
  rawHeadless: unknown,
): { headlessMode: "new" | "old" | "off"; headlessModePinned: boolean } {
  if (rawMode === "new" || rawMode === "old" || rawMode === "off") {
    return { headlessMode: rawMode, headlessModePinned: true };
  }
  if (rawHeadless === false) {
    return { headlessMode: "off", headlessModePinned: false };
  }
  return { headlessMode: "new", headlessModePinned: false };
}

export function readConfig(raw: unknown): BrowserConfig {
  const r: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const { headlessMode, headlessModePinned } = resolveHeadlessMode(r.headlessMode, r.headless);
  return {
    chromePath: nullableString(r.chromePath),
    headless: bool(r.headless, DEFAULTS.headless),
    headlessMode,
    headlessModePinned,
    remoteDebugPort: finiteNumber(r.remoteDebugPort, DEFAULTS.remoteDebugPort),
    navigationTimeoutMs: finiteNumber(r.navigationTimeoutMs, DEFAULTS.navigationTimeoutMs),
    commandTimeoutMs: finiteNumber(r.commandTimeoutMs, DEFAULTS.commandTimeoutMs),
    maxTextChars: finiteNumber(r.maxTextChars, DEFAULTS.maxTextChars),
    screenshotDir: nullableString(r.screenshotDir),
    guidance: nullableString(r.guidance),
    guidancePriority: finiteNumber(r.guidancePriority, DEFAULTS.guidancePriority),
    resultsPriority: finiteNumber(r.resultsPriority, DEFAULTS.resultsPriority),
    maxResults: finiteNumber(r.maxResults, DEFAULTS.maxResults),
    maxResultChars: finiteNumber(r.maxResultChars, DEFAULTS.maxResultChars),
    maxResultsTotalChars: finiteNumber(r.maxResultsTotalChars, DEFAULTS.maxResultsTotalChars),
    maxFailureNotices: finiteNumber(r.maxFailureNotices, DEFAULTS.maxFailureNotices),
  };
}

export function buildDefaultGuidance(cfg: BrowserConfig): string {
  void cfg;
  return [
    "You have READ + NAVIGATE control of a Krakey-managed Chrome browser.",
    "These five tools are available to you:",
    "- browser.navigate — navigate the active tab to an absolute URL.",
    "- browser.read_page — read the current page as text (default) or html.",
    "- browser.list_tabs — list the open browser tabs.",
    "- browser.activate_tab — make a given tab the active one.",
    "- browser.screenshot — capture a PNG screenshot of the active tab.",
    "",
    "This is READ and NAVIGATE only: you observe pages and move between them, but",
    "cannot interact with page elements, submit forms, or run scripts.",
    "Chrome launches on demand the first time you use a tool, and is relaunched",
    "automatically if it crashes.",
    "",
    'Tool results do not come back inline — they arrive on the NEXT frame, tagged',
    '"browser". After you call a tool, wait for the next frame and read the',
    '"browser"-tagged result before deciding what to do.',
  ].join("\n");
}

export function capText(s: string, max: number): { content: string; truncated: boolean; chars: number } {
  const chars = s.length;
  if (chars <= max) {
    return { content: s, truncated: false, chars };
  }
  return {
    content: s.slice(0, max) + "\n…(" + (s.length - max) + " chars truncated)",
    truncated: true,
    chars,
  };
}

export function sanitizeScreenshotName(name: unknown, now: number): string {
  if (typeof name === "string" && name.length > 0) {
    return name.replace(/[\/\\]/g, "_") + ".png";
  }
  return "screenshot_" + now + ".png";
}

export interface ResultEntry {
  at: number;
  toolName: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  url?: string;
}

export function pushResult(ring: ResultEntry[], entry: ResultEntry, max: number): ResultEntry[] {
  return [...ring, entry].slice(-max);
}

/**
 * A persistent-failure ledger entry: one distinct (toolName + normalized error)
 * that has failed one or more frames in a row, surviving across frames until that
 * tool next succeeds. `count` is the consecutive-failure count for this exact pair.
 */
export interface FailureEntry {
  toolName: string;
  error: string;
  count: number;
  firstAt: number;
  lastAt: number;
}

/**
 * Normalize a raw tool error into a stable, bounded string for keying/display:
 * coerce to String, trim, fall back to "unknown" when empty/missing, cap ~300 chars.
 */
export function normalizeFailureError(error: unknown): string {
  let s = "";
  try {
    s = String(error ?? "").trim();
  } catch {
    s = "";
  }
  if (s.length === 0) s = "unknown";
  if (s.length > 300) s = s.slice(0, 300);
  return s;
}

/**
 * Upsert a failure into the ledger keyed by (toolName + normalized error), then
 * bound the ledger to `max` entries dropping OLDEST-first (insertion order).
 *
 * Existing pair → count++, lastAt = at. New pair → push {count:1, firstAt:at, lastAt:at}.
 * `max <= 0` DISABLES the ledger entirely (returns an empty ledger, records nothing).
 */
export function pushFailure(
  ledger: FailureEntry[],
  toolName: string,
  error: unknown,
  at: number,
  max: number,
): FailureEntry[] {
  if (!(typeof max === "number" && max > 0)) return [];
  const err = normalizeFailureError(error);
  const next = ledger.map((e) => ({ ...e }));
  const hit = next.find((e) => e.toolName === toolName && e.error === err);
  if (hit) {
    hit.count += 1;
    hit.lastAt = at;
  } else {
    next.push({ toolName, error: err, count: 1, firstAt: at, lastAt: at });
  }
  return next.slice(-max);
}

/**
 * Remove EVERY ledger entry for a tool (clear by tool, not tool+error) — called
 * when that tool next succeeds so a resolved failure stops being reported.
 */
export function clearFailuresForTool(ledger: FailureEntry[], toolName: string): FailureEntry[] {
  return ledger.filter((e) => e.toolName !== toolName);
}

/**
 * The persistent-failure notice line for one ledger entry. Rendered only for
 * entries with count >= 2 (the first failure already renders as a normal result).
 * The 'failed <N>x in a row' phrasing and the reflect sentence are matched by tests.
 */
export function formatFailureLine(entry: FailureEntry): string {
  return (
    "[browser persistent failure] " +
    entry.toolName +
    " has failed " +
    entry.count +
    "x in a row with the same error: " +
    entry.error +
    ". This failure is persistent - retrying the same call unchanged will NOT succeed. " +
    "Reflect on why it is failing and change your approach, or stop and report it; " +
    "do not keep re-calling it."
  );
}

export function renderResults(
  results: ResultEntry[],
  cfg: BrowserConfig,
  failures: FailureEntry[] = [],
): Message[] {
  // Persistent-failure notices render FIRST, one per ledger entry with count >= 2
  // (a count of 1 already surfaced as a normal result that frame). Each line is
  // capped independently by maxResultChars.
  const failureMessages: Message[] = failures
    .filter((f) => f.count >= 2)
    .map((f): Message => ({
      role: "user",
      name: "browser",
      content: capText(formatFailureLine(f), cfg.maxResultChars).content,
    }));

  if (results.length === 0) return failureMessages;

  const header = (entry: ResultEntry): string =>
    "[browser tool result | " +
    entry.toolName +
    " | " +
    (entry.ok ? "ok" : "error") +
    " | url: " +
    (entry.url ?? "") +
    " | " +
    new Date(entry.at).toISOString() +
    "]";

  const body = (entry: ResultEntry): string =>
    entry.ok
      ? capText(JSON.stringify(entry.data, null, 2), cfg.maxResultChars).content
      : capText("Error: " + (entry.error ?? "unknown"), cfg.maxResultChars).content;

  // NEWEST-FIRST char budget: walk from newest backwards. The newest entry is
  // always full; each older entry is full only while the running total of full
  // contents stays within budget, else that entry (and all older) are header-only.
  const fullByIndex = new Array<boolean>(results.length).fill(false);
  let total = 0;
  let budgetExhausted = false;
  for (let i = results.length - 1; i >= 0; i--) {
    const isNewest = i === results.length - 1;
    const fullContent = header(results[i]) + "\n" + body(results[i]);
    if (isNewest) {
      fullByIndex[i] = true;
      total += fullContent.length;
      continue;
    }
    if (!budgetExhausted && total + fullContent.length <= cfg.maxResultsTotalChars) {
      fullByIndex[i] = true;
      total += fullContent.length;
    } else {
      budgetExhausted = true;
      fullByIndex[i] = false;
    }
  }

  const resultMessages = results.map((entry, i): Message => {
    const content = fullByIndex[i] ? header(entry) + "\n" + body(entry) : header(entry);
    return { role: "user", name: "browser", content };
  });

  return [...failureMessages, ...resultMessages];
}
