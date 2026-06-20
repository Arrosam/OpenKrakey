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
}

const DEFAULTS: BrowserConfig = {
  chromePath: null,
  headless: true,
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

export function readConfig(raw: unknown): BrowserConfig {
  const r: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    chromePath: nullableString(r.chromePath),
    headless: bool(r.headless, DEFAULTS.headless),
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
    'Tool results do not come back inline — they arrive on the NEXT beat, tagged',
    '"browser". After you call a tool, wait for the next beat and read the',
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

export function renderResults(results: ResultEntry[], cfg: BrowserConfig): Message[] {
  if (results.length === 0) return [];

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

  return results.map((entry, i): Message => {
    const content = fullByIndex[i] ? header(entry) + "\n" + body(entry) : header(entry);
    return { role: "user", name: "browser", content };
  });
}
