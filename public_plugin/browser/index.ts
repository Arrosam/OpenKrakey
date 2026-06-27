/**
 * browser plugin · default export = PluginFactory
 *
 * Gives a Krakey Agent READ + NAVIGATE control of a Krakey-managed Chrome over
 * raw Chrome DevTools Protocol. Registers five actions + their llm tool defs,
 * publishes a guidance block (system) and a results block (messages), and turns
 * each own tool.result into a "browser"-tagged message on the next frame.
 *
 * ALL mutable state lives in the factory closure / the ChromeClient instance
 * (R6 per-Agent isolation). The module level holds only immutable consts.
 */
import {
  readConfig,
  buildDefaultGuidance,
  capText,
  sanitizeScreenshotName,
  pushResult,
  renderResults,
  type ResultEntry,
  type BrowserConfig,
} from "./config";
import { ChromeClient } from "./cdp";
import { BROWSER_SCHEMA } from "./config-schema";
import { Actions, Events } from "../../shared/actions";
import type { Message, ToolDef } from "../../contracts/llm";
import type { Plugin, PluginContext, PluginFactory } from "../../contracts/plugin";
import path from "node:path";
import fsp from "node:fs/promises";

const OWN_TOOLS = new Set<string>([
  "browser.navigate",
  "browser.read_page",
  "browser.list_tabs",
  "browser.activate_tab",
  "browser.screenshot",
]);

const NAVIGATE_TOOL: ToolDef = {
  name: "browser.navigate",
  description:
    "Navigate the read/navigate-only browser's active tab to an absolute URL. " +
    'The result arrives on the next frame, tagged "browser".',
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute URL" } },
    required: ["url"],
  },
};

const READ_PAGE_TOOL: ToolDef = {
  name: "browser.read_page",
  description:
    "Read the active tab's current page (read/navigate-only). " +
    'The result arrives on the next frame, tagged "browser".',
  parameters: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["text", "html"], description: "text (default) or html" },
    },
    required: [],
  },
};

const LIST_TABS_TOOL: ToolDef = {
  name: "browser.list_tabs",
  description:
    "List the open browser tabs (read/navigate-only). " +
    'The result arrives on the next frame, tagged "browser".',
  parameters: { type: "object", properties: {}, required: [] },
};

const ACTIVATE_TAB_TOOL: ToolDef = {
  name: "browser.activate_tab",
  description:
    "Make a given tab the active one (read/navigate-only). " +
    'The result arrives on the next frame, tagged "browser".',
  parameters: {
    type: "object",
    properties: { tabId: { type: "string" } },
    required: ["tabId"],
  },
};

const SCREENSHOT_TOOL: ToolDef = {
  name: "browser.screenshot",
  description:
    "Capture a PNG screenshot of the active tab (read/navigate-only). " +
    'The result arrives on the next frame, tagged "browser".',
  parameters: {
    type: "object",
    properties: { filename: { type: "string" } },
    required: [],
  },
};

const createBrowser: PluginFactory = (): Plugin => {
  let client: ChromeClient | null = null;
  let results: ResultEntry[] = [];
  let unsubs: Array<() => void> = [];

  return {
    manifest: {
      id: "browser",
      version: "0.1.0",
      requires: ["llm.register_tool"],
      configSchema: BROWSER_SCHEMA,
    },

    async setup(ctx: PluginContext): Promise<void> {
      const cfg: BrowserConfig = readConfig(ctx.config);
      const screenshotDir =
        cfg.screenshotDir && cfg.screenshotDir.length > 0
          ? path.resolve(cfg.screenshotDir)
          : path.join(ctx.dataDir, "screenshots");

      const ensureClient = async (): Promise<ChromeClient> => {
        if (client && !client.exited) return client;
        const c = new ChromeClient(cfg, ctx.dataDir);
        await c.launch();
        client = c;
        return c;
      };

      const offNavigate = ctx.actions.register(
        "browser.navigate",
        async (params: unknown): Promise<unknown> => {
          const p = (params ?? {}) as Record<string, unknown>;
          if (typeof p.url !== "string" || p.url.trim().length === 0) {
            throw new Error("browser.navigate: 'url' must be a non-empty string");
          }
          try {
            new URL(p.url);
          } catch {
            throw new Error("browser.navigate: invalid URL: " + p.url);
          }
          const c = await ensureClient();
          const targetId = await c.ensureActiveTarget();
          const sid = await c.ensureSession(targetId);
          const t0 = Date.now();
          const nav = (await c.sendCommand("Page.navigate", { url: p.url }, sid)) as {
            errorText?: string;
          };
          if (nav?.errorText) throw new Error("browser.navigate: " + nav.errorText);
          let timedOut = false;
          const deadline = Date.now() + cfg.navigationTimeoutMs;
          for (;;) {
            const r = (await c.sendCommand(
              "Runtime.evaluate",
              { expression: "document.readyState", returnByValue: true },
              sid,
            )) as { result?: { value?: unknown } };
            if (r?.result?.value === "complete") break;
            if (Date.now() > deadline) {
              timedOut = true;
              break;
            }
            await new Promise((res) => setTimeout(res, 100));
          }
          const loc = (await c.sendCommand(
            "Runtime.evaluate",
            { expression: "location.href", returnByValue: true },
            sid,
          )) as { result?: { value?: unknown } };
          const ttl = (await c.sendCommand(
            "Runtime.evaluate",
            { expression: "document.title", returnByValue: true },
            sid,
          )) as { result?: { value?: unknown } };
          return {
            url: p.url,
            finalUrl: loc?.result?.value ?? p.url,
            title: ttl?.result?.value ?? "",
            loadedMs: Date.now() - t0,
            timedOut,
          };
        },
      );

      const offRead = ctx.actions.register(
        "browser.read_page",
        async (params: unknown): Promise<unknown> => {
          const p = (params ?? {}) as Record<string, unknown>;
          const format = p.format === "html" ? "html" : "text";
          const c = await ensureClient();
          const targetId = await c.ensureActiveTarget();
          const sid = await c.ensureSession(targetId);
          const expr =
            format === "html"
              ? "document.documentElement ? document.documentElement.outerHTML : ''"
              : "document.body ? document.body.innerText : ''";
          const r = (await c.sendCommand(
            "Runtime.evaluate",
            { expression: expr, returnByValue: true },
            sid,
          )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
          if (r?.exceptionDetails) throw new Error("browser.read_page: evaluate failed");
          const raw = String(r?.result?.value ?? "");
          const cap = capText(raw, cfg.maxTextChars);
          const loc = (await c.sendCommand(
            "Runtime.evaluate",
            { expression: "location.href", returnByValue: true },
            sid,
          )) as { result?: { value?: unknown } };
          const ttl = (await c.sendCommand(
            "Runtime.evaluate",
            { expression: "document.title", returnByValue: true },
            sid,
          )) as { result?: { value?: unknown } };
          return {
            format,
            url: loc?.result?.value ?? "",
            title: ttl?.result?.value ?? "",
            content: cap.content,
            truncated: cap.truncated,
            chars: cap.chars,
          };
        },
      );

      const offList = ctx.actions.register(
        "browser.list_tabs",
        async (): Promise<unknown> => {
          if (!client || client.exited) return { launched: false, tabs: [] };
          const targets = await client.listTargets();
          return {
            launched: true,
            tabs: targets.map((t) => ({
              id: t.id,
              title: t.title,
              url: t.url,
              active: t.id === client!.activeTargetId,
            })),
          };
        },
      );

      const offActivate = ctx.actions.register(
        "browser.activate_tab",
        async (params: unknown): Promise<unknown> => {
          const p = (params ?? {}) as Record<string, unknown>;
          if (typeof p.tabId !== "string" || p.tabId.length === 0) {
            throw new Error("browser.activate_tab: 'tabId' must be a non-empty string");
          }
          const c = await ensureClient();
          const targets = await c.listTargets();
          const hit = targets.find((t) => t.id === p.tabId);
          if (!hit) throw new Error("browser.activate_tab: no tab with id " + p.tabId);
          c.activeTargetId = p.tabId;
          return { tabId: p.tabId, title: hit.title, url: hit.url };
        },
      );

      const offShot = ctx.actions.register(
        "browser.screenshot",
        async (params: unknown): Promise<unknown> => {
          const p = (params ?? {}) as Record<string, unknown>;
          const c = await ensureClient();
          const targetId = await c.ensureActiveTarget();
          const sid = await c.ensureSession(targetId);
          const r = (await c.sendCommand(
            "Page.captureScreenshot",
            { format: "png", captureBeyondViewport: false },
            sid,
          )) as { data?: unknown };
          const b64 = String(r?.data ?? "");
          const buf = Buffer.from(b64, "base64");
          await fsp.mkdir(screenshotDir, { recursive: true });
          const name = sanitizeScreenshotName(p.filename, Date.now());
          const outPath = path.join(screenshotDir, name);
          await fsp.writeFile(outPath, buf);
          return { path: outPath, bytes: buf.length };
        },
      );

      for (const def of [
        NAVIGATE_TOOL,
        READ_PAGE_TOOL,
        LIST_TABS_TOOL,
        ACTIVATE_TAB_TOOL,
        SCREENSHOT_TOOL,
      ]) {
        try {
          await ctx.actions.invoke("llm.register_tool", def);
        } catch (e) {
          ctx.log.warn("browser: failed to register tool " + def.name + ": " + String(e));
        }
      }

      ctx.setBlock({
        id: "browser.guidance",
        label: "browser.guidance",
        target: "system",
        priority: cfg.guidancePriority,
        render: (): string => (cfg.guidance !== null ? cfg.guidance : buildDefaultGuidance(cfg)),
      });

      ctx.setBlock({
        id: "browser.results",
        target: "messages",
        priority: cfg.resultsPriority,
        render: (): Message[] => renderResults(results, cfg),
      });

      const offResult = ctx.events.on(Events.TOOL_RESULT, (payload: unknown): void => {
        try {
          if (payload === null || typeof payload !== "object") return;
          const q = payload as {
            name?: unknown;
            at?: unknown;
            ok?: unknown;
            data?: unknown;
            error?: unknown;
          };
          if (typeof q.name !== "string" || !OWN_TOOLS.has(q.name)) return;
          const d = q.data as Record<string, unknown> | undefined;
          const url =
            typeof d?.url === "string"
              ? d.url
              : typeof d?.finalUrl === "string"
                ? d.finalUrl
                : undefined;
          results = pushResult(
            results,
            {
              at: typeof q.at === "number" ? q.at : Date.now(),
              toolName: q.name,
              ok: !!q.ok,
              data: q.data,
              error: typeof q.error === "string" ? q.error : undefined,
              url,
            },
            cfg.maxResults,
          );
          if (ctx.actions.has(Actions.CLOCK_FIRE_NOW)) {
            ctx.actions.invoke(Actions.CLOCK_FIRE_NOW).catch(() => {});
          }
        } catch {
          /* never throw */
        }
      });

      unsubs = [
        offNavigate,
        offRead,
        offList,
        offActivate,
        offShot,
        offResult,
        () => ctx.removeBlock("browser.guidance"),
        () => ctx.removeBlock("browser.results"),
      ];

      ctx.print("browser: Chrome control ready (read+navigate)");
    },

    async teardown(): Promise<void> {
      for (const off of unsubs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
      unsubs = [];
      if (client) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
        client = null;
      }
      results = [];
    },
  };
};

export default createBrowser;
