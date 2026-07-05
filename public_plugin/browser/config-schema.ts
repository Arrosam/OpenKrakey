import type { ConfigSchema } from "../../contracts/plugin";

export const BROWSER_SCHEMA: ConfigSchema = [
  { key: "headless", label: "Headless", type: "boolean", default: true, help: "Run Chrome without a visible window." },
  { key: "headlessMode", label: "Headless mode", type: "enum", default: "new", options: [{ value: "new", label: "New headless (default)" }, { value: "old", label: "Legacy headless" }, { value: "off", label: "Windowed (not headless)" }], help: "Chrome headless mode. New is fastest; if Chrome exits immediately on launch (some macOS arm64 setups) it auto-falls back to legacy. Choose Windowed for a visible browser window." },
  { key: "chromePath", label: "Chrome executable path", type: "string", default: null, placeholder: "(auto-detect)", example: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", help: "Absolute path to the Chrome (or Chromium) binary. Leave blank to auto-detect." },
  { key: "remoteDebugPort", label: "Remote debug port", type: "number", default: 0, min: 0, max: 65535, step: 1, help: "0 = pick a free port automatically." },
  { key: "navigationTimeoutMs", label: "Navigation timeout", type: "number", default: 30000, min: 1, step: 1000, unit: "ms", help: "Maximum time to wait for a page navigation to complete." },
  { key: "commandTimeoutMs", label: "Command timeout", type: "number", default: 10000, min: 1, step: 500, unit: "ms", help: "Maximum time for individual browser commands." },
  { key: "maxTextChars", label: "Max page text chars", type: "number", default: 50000, min: 1, step: 1000, help: "Character cap on text extracted from a page." },
  { key: "screenshotDir", label: "Screenshot directory", type: "string", default: null, placeholder: "(plugin data dir)/screenshots", help: "Directory where screenshots are saved. Leave blank to use the plugin data dir." },
  { key: "guidance", label: "Guidance override", type: "text", placeholder: "(uses built-in guidance)", help: "Overrides the browser.guidance system block text shown to the LLM." },
  { key: "guidancePriority", label: "Guidance block priority", type: "number", default: 5500, min: 0, step: 100 },
  { key: "resultsPriority", label: "Results block priority", type: "number", default: 3000, min: 0, step: 100 },
  { key: "maxResults", label: "Results kept", type: "number", default: 10, min: 0, step: 1, help: "How many recent browser tool results are kept in the ring." },
  { key: "maxResultChars", label: "Chars per result", type: "number", default: 4000, min: 1, step: 100, help: "Character cap per individual browser result injected into the prompt." },
  { key: "maxResultsTotalChars", label: "Total result chars", type: "number", default: 16000, min: 1, step: 100, help: "Total character budget across all browser results in the prompt." },
];
