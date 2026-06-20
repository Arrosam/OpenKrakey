/**
 * browser plugin · cdp — Chrome lifecycle + raw Chrome DevTools Protocol.
 *
 * ZERO npm deps: speaks CDP over Node's GLOBAL WebSocket and discovers targets
 * via the GLOBAL fetch against Chrome's /json HTTP endpoints. The ChromeClient
 * owns the spawned Chrome process and the single CDP WebSocket; all mutable
 * state lives on the instance (R6 per-Agent isolation).
 *
 * The exported pure helpers (findChromeBinary, buildCdpMessage, getFreePort)
 * are unit-testable without launching Chrome.
 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { BrowserConfig } from "./config";

function defaultExists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function chromeCandidates(platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.PROGRAMFILES ?? "";
    const programFilesX86 = process.env["PROGRAMFILES(X86)"] ?? "";
    const sub = (base: string, vendor: string, exe: string): string =>
      path.join(base, vendor, "Application", exe);
    return [
      sub(localAppData, "Google\\Chrome", "chrome.exe"),
      sub(programFiles, "Google\\Chrome", "chrome.exe"),
      sub(programFilesX86, "Google\\Chrome", "chrome.exe"),
      sub(localAppData, "Chromium", "chrome.exe"),
      sub(programFiles, "Chromium", "chrome.exe"),
      sub(programFilesX86, "Chromium", "chrome.exe"),
    ];
  }
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
}

export function findChromeBinary(
  override: string | null,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = defaultExists,
): string {
  if (typeof override === "string" && override.length > 0) {
    return override;
  }
  for (const candidate of chromeCandidates(platform)) {
    if (candidate.length > 0 && exists(candidate)) {
      return candidate;
    }
  }
  throw new Error("browser: no Chrome/Chromium binary found. Set chromePath in config.");
}

export function buildCdpMessage(
  id: number,
  method: string,
  params: unknown,
  sessionId?: string,
): Record<string, unknown> {
  const msg: Record<string, unknown> = { id, method, params };
  if (typeof sessionId === "string" && sessionId.length > 0) {
    msg.sessionId = sessionId;
  }
  return msg;
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PageTarget {
  id: string;
  type: string;
  title: string;
  url: string;
}

export class ChromeClient {
  private child: import("node:child_process").ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, string>();
  activeTargetId: string | null = null;
  exited = false;
  private port = 0;

  constructor(private cfg: BrowserConfig, private dataDir: string) {}

  async launch(): Promise<void> {
    const bin = findChromeBinary(this.cfg.chromePath);
    this.port = this.cfg.remoteDebugPort > 0 ? this.cfg.remoteDebugPort : await getFreePort();
    const args = [
      "--remote-debugging-port=" + this.port,
      "--user-data-dir=" + path.join(this.dataDir, "profile"),
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--safebrowsing-disable-auto-update",
      "--password-store=basic",
      ...(this.cfg.headless ? ["--headless=new", "--disable-gpu"] : []),
      "about:blank",
    ];
    this.child = spawn(bin, args, { stdio: "ignore", detached: false });
    this.child.unref();
    this.child.on("exit", () => {
      this.exited = true;
      this.child = null;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("browser: Chrome process exited unexpectedly"));
      }
      this.pending.clear();
      this.sessions.clear();
    });

    const child = this.child;

    // 1) wait for the process to actually start (or fail to start) — no uncaught 'error'
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.exited = true;
        this.child = null;
        reject(new Error(`browser: failed to launch Chrome (${bin}): ${err.message}`));
      };
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    // 2) keep a PERSISTENT error handler so a later spawn/runtime error never crashes the host
    child.on("error", (err: Error) => {
      this.exited = true;
      this.child = null;
      try {
        this.ws?.close();
      } catch {
        /* ignore */
      }
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`browser: Chrome process error: ${err.message}`));
      }
      this.pending.clear();
      this.sessions.clear();
    });

    const debuggerUrl = await this.waitForDebuggerReady();
    await this.connectWs(debuggerUrl);
  }

  private async waitForDebuggerReady(): Promise<string> {
    const deadline = Date.now() + this.cfg.commandTimeoutMs;
    for (;;) {
      try {
        const res = await fetch("http://127.0.0.1:" + this.port + "/json/version");
        if (res.status === 200) {
          const json = (await res.json()) as { webSocketDebuggerUrl?: string };
          return String(json.webSocketDebuggerUrl ?? "");
        }
      } catch {
        /* not ready yet */
      }
      if (Date.now() > deadline) {
        throw new Error(
          "browser: Chrome debugger not ready after " + this.cfg.commandTimeoutMs + "ms",
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private connectWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error("browser: CDP WebSocket connection timed out"));
      }, this.cfg.commandTimeoutMs);

      ws.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });
      ws.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error("browser: CDP WebSocket connection failed"));
      });
      ws.onmessage = (ev: MessageEvent) => {
        let msg: { id?: unknown; error?: unknown; result?: unknown };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (typeof msg.id === "number" && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          clearTimeout(p.timer);
          this.pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error("CDP error: " + JSON.stringify(msg.error)));
          } else {
            p.resolve(msg.result);
          }
        }
        // else: a CDP event (no id) — ignored.
      };
    });
  }

  sendCommand(method: string, params: unknown = {}, sessionId?: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws) {
        reject(new Error("browser: CDP WebSocket is not connected"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            'browser: CDP command "' + method + '" timed out after ' + this.cfg.commandTimeoutMs + "ms",
          ),
        );
      }, this.cfg.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(buildCdpMessage(id, method, params, sessionId)));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async ensureSession(targetId: string): Promise<string> {
    const existing = this.sessions.get(targetId);
    if (existing !== undefined) return existing;
    const { sessionId } = (await this.sendCommand("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    this.sessions.set(targetId, sessionId);
    await this.sendCommand("Page.enable", {}, sessionId);
    return sessionId;
  }

  async listTargets(): Promise<PageTarget[]> {
    const res = await fetch("http://127.0.0.1:" + this.port + "/json/list");
    const json = (await res.json()) as Array<Record<string, unknown>>;
    return json
      .filter((t) => t.type === "page")
      .map((t): PageTarget => ({
        id: String(t.id ?? ""),
        type: String(t.type ?? ""),
        title: String(t.title ?? ""),
        url: String(t.url ?? ""),
      }));
  }

  async newTarget(): Promise<string> {
    const res = await fetch("http://127.0.0.1:" + this.port + "/json/new", { method: "PUT" });
    const json = (await res.json()) as { id?: unknown };
    return String(json.id ?? "");
  }

  async ensureActiveTarget(): Promise<string> {
    const targets = await this.listTargets();
    if (this.activeTargetId && targets.some((t) => t.id === this.activeTargetId)) {
      return this.activeTargetId;
    }
    const first = targets[0];
    const id = first ? first.id : await this.newTarget();
    this.activeTargetId = id;
    return id;
  }

  async close(): Promise<void> {
    try {
      this.child?.kill();
    } catch {
      /* ignore */
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
    }
    this.pending.clear();
    this.sessions.clear();
    this.child = null;
    this.ws = null;
  }
}
