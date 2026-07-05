#!/usr/bin/env -S tsx
/**
 * cli — bin entry. The top-level `krakey <command>` dispatcher: a thin process
 * shell that reads process.argv, hands it to the pure parser (./dispatcher),
 * then acts on the result — running the interactive config console in-process,
 * spawning a sibling bin (boot, console) as a child, or driving lifecycle/admin
 * commands (background start/stop, dashboard, uninstall, update). This is the
 * only place process.argv / process.cwd() / process.env / fs / spawn are touched.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { PATHS } from "../../../shared/config";

import { parseCommand } from "./dispatcher";
import { createCli } from "./index";
import { runInteractiveLoop } from "./pages";
import { rotateLog, stopPidFile, superviseLoop } from "./supervisor";
import { ensureSurfaceTokens, surfaceUrl } from "./surfaces";

// Version comes from the repo-root package.json, resolved relative to this file
// (NOT cwd) so `krakey version` is stable wherever it is invoked from.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
) as { version: string };

// Sibling bins, resolved as absolute paths from this file's location. They are
// passed as strings to the child; this worktree need not contain them.
const bootBin = fileURLToPath(new URL("../../boot/src/index.ts", import.meta.url));
const consoleBin = fileURLToPath(new URL("../../console/src/bin.ts", import.meta.url));
const configWebBin = fileURLToPath(new URL("../../config-web/src/bin.ts", import.meta.url));
// The supervisor process `krakey start` detaches; it relaunches boot on
// RESTART_EXIT_CODE. Lives in THIS package, resolved from this file's location.
const supervisorBin = fileURLToPath(new URL("./supervisor-entry.ts", import.meta.url));

// The OpenKrakey install root (three levels up from packages/cli/src/bin.ts).
// Lifecycle state and the install scripts live relative to this, never cwd.
// `resolve` strips the URL's trailing separator — critical for the uninstall
// cleaner, where a trailing `\` would escape the closing quote in the Windows
// `rmdir /s /q "<root>\"` command and silently break the deletion.
const REPO_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

// Per-install runtime state (PID list + log). Git-ignored; created on demand.
const STATE_DIR = join(REPO_ROOT, ".krakey");
const PID_FILE = join(STATE_DIR, "run.pid");
// Dashboard (console + config-web) pids live SEPARATELY from the runtime's: they
// are torn down by `krakey stop` but NOT by `krakey restart` — so clicking the
// config UI's "restart to apply" (which runs `krakey restart`) never kills the very
// Console the user is looking at.
const DASH_PID_FILE = join(STATE_DIR, "dashboard.pid");
const LOG_FILE = join(STATE_DIR, "krakey.log");

const DEFAULT_DASHBOARD_PORT = "7716";

const USAGE = `usage: krakey [command]

commands:
  krakey              show this help
  krakey help         show this help
  krakey setup        open the terminal config tool (arrow-key TUI)
  krakey agent        edit agents
  krakey default      edit default settings (the template new agents copy)
  krakey providers    edit AI services (providers, endpoints, keys)
  krakey run          launch the runtime in the foreground (Ctrl+C to stop)
  krakey start        launch the runtime in the background (daemon)
  krakey stop         stop the background runtime AND dashboard
  krakey restart      restart the background runtime (stop, then start)
  krakey dashboard    open the unified Console in the browser, in the background — recommended setup  [port]
  krakey uninstall    remove Krakey entirely from this machine  [--yes]
  krakey update       pull the latest version and re-run the installer
  krakey version      print the version

new here? run 'krakey dashboard' for the guided browser setup (the Console).`;

/**
 * Launch a sibling bin the way `npm test` runs tsx — `node --import tsx <bin>`.
 * The child shares this process group, so it handles Ctrl+C itself; we keep the
 * parent alive and just mirror the child's exit code. Used for the FOREGROUND
 * runtime (`krakey run`), supervised: a boot that exits with RESTART_EXIT_CODE
 * is relaunched in place; the first terminal code becomes this process's exit
 * code. The SIGINT no-op keeps Ctrl+C handled by the child, not us.
 */
async function spawnChild(binPath: string, extraArgs: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  process.on("SIGINT", () => {});
  const launch = (): Promise<number | null> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", binPath, ...extraArgs], {
        stdio: "inherit",
        env: env ?? process.env,
      });
      child.on("error", (err) => {
        console.error(`krakey: failed to launch ${binPath}: ${err.message}`);
        resolve(1);
      });
      child.on("close", (code) => resolve(code));
    });
  const code = await superviseLoop(launch, {
    onRestart: () => console.log("krakey: restarting…"),
  });
  process.exitCode = code;
}

/** Ensure `.krakey/` exists so the PID list and log can be written. */
function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * Stop the background RUNTIME (boot) instances only — the daemons `krakey start`
 * records in PID_FILE. Used by `restart` (which must NOT touch the dashboard) and
 * the best-effort step of `uninstall`. Returns how many recorded pids were still
 * live when killed (see supervisor.stopPidFile).
 */
function stopAll(): number {
  return stopPidFile(PID_FILE).alive;
}

/**
 * Launch the runtime DETACHED — log to .krakey/krakey.log, record the pid, and
 * return immediately (the child is unref'd so it outlives this process). Shared
 * by `start` and `restart`.
 *
 * The detached child is the SUPERVISOR (not boot directly): it inherits the log
 * fds via stdio and relaunches boot on RESTART_EXIT_CODE. PID_FILE records the
 * supervisor's pid — killTree tears down its whole tree (boot included).
 */
function startBackground(): void {
  // Rotate the previous run's log to krakey.log.old FIRST, before anything reopens
  // it — a fresh daemon starts with a clean log; the prior one is preserved as .old.
  rotateLog(LOG_FILE);
  ensureStateDir();
  // Pin stable tokens for the runtime's token-gated surfaces BEFORE boot reads the
  // configs, so `krakey dashboard` can authenticate the framed Chat/Inspector panels.
  ensureSurfaceTokens(resolve(process.cwd(), PATHS.agentsDir));
  const logFd = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, ["--import", "tsx", supervisorBin, "--boot", bootBin], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  child.unref();
  if (child.pid !== undefined) appendFileSync(PID_FILE, `${child.pid}\n`, "utf8");
  console.log(`krakey: started in background (pid ${child.pid ?? "?"})`);
  console.log(`        log: ${LOG_FILE}`);
  console.log("        stop with: krakey stop");
}

/** Open `http://127.0.0.1:<port>` in the default browser, cross-platform. */
function openBrowser(url: string): void {
  if (process.platform === "win32") {
    // The empty "" is the (ignored) window title `start` expects as its first arg.
    spawn("cmd", ["/c", "start", "", url], { windowsHide: true });
  } else if (process.platform === "darwin") {
    spawn("open", [url]);
  } else {
    spawn("xdg-open", [url]);
  }
}

const parsed = parseCommand(process.argv.slice(2));

switch (parsed.kind) {
  case "help":
    console.log(USAGE);
    break;

  case "version":
    console.log(pkg.version);
    break;

  case "setup": {
    const cwd = process.cwd();
    const cli = createCli({
      agentsDir: resolve(cwd, PATHS.agentsDir),
      defaultPath: resolve(cwd, PATHS.defaultPath),
      publicPluginDir: resolve(cwd, PATHS.publicPluginDir),
      llmPath: resolve(cwd, PATHS.llmPath),
    });
    await runInteractiveLoop(cli, parsed.page);
    break;
  }

  case "run":
    // Foreground runtime — boot all configured agents, Ctrl+C to stop.
    // Pin surface tokens first so a later `krakey dashboard` can authenticate Chat/Inspector.
    ensureSurfaceTokens(resolve(process.cwd(), PATHS.agentsDir));
    // Supervised in-process: relaunches boot on RESTART_EXIT_CODE, mirrors the
    // terminal exit code. Awaited so process.exitCode is set before we fall through.
    await spawnChild(bootBin, []);
    break;

  case "start":
    // Background runtime (detached). Returns immediately.
    startBackground();
    break;

  case "stop": {
    // Stop EVERYTHING krakey backgrounded: the runtime daemon(s) AND the dashboard
    // (console + config-web). `restart` deliberately stops only the runtime.
    const runtime = stopPidFile(PID_FILE);
    const dash = stopPidFile(DASH_PID_FILE);
    // aliveTotal = pids that were actually running when killed; staleTotal = pids
    // recorded in the files that had already died (stale entries we just cleaned up).
    const aliveTotal = runtime.alive + dash.alive;
    const staleTotal =
      runtime.targeted - runtime.alive + (dash.targeted - dash.alive);
    if (aliveTotal === 0 && staleTotal === 0) {
      console.log("krakey: no running instances");
    } else if (aliveTotal === 0) {
      console.log("krakey: was not running (stale pid file removed)");
    } else {
      console.log(
        `krakey: stopped ${aliveTotal} instance${aliveTotal === 1 ? "" : "s"} (runtime + dashboard)`,
      );
    }
    break;
  }

  case "restart": {
    // Stop any background instance(s), then start a fresh detached one.
    const stopped = stopAll();
    console.log(
      stopped === 0
        ? "krakey: no running instance — starting fresh"
        : `krakey: stopped ${stopped} instance${stopped === 1 ? "" : "s"}, restarting…`,
    );
    startBackground();
    break;
  }

  case "dashboard": {
    // Open the unified Console in the browser. The Console frames three surfaces
    // (Config 7717 · Chat 7718 · Inspector 7719). We always launch config-web so
    // the Config panel is usable for first-run setup BEFORE any agent is running;
    // Chat + Inspector belong to the runtime and only fill in once you `krakey
    // start`. BOTH the Console and config-web run as BACKGROUND daemons (so the
    // terminal is freed immediately) and are PID-tracked in DASH_PID_FILE so
    // `krakey stop` tears them down — but `krakey restart` does not.
    const port = parsed.port !== undefined ? parsed.port : DEFAULT_DASHBOARD_PORT;
    const url = `http://127.0.0.1:${port}`;

    // config-web is token-gated; reuse an explicit token if set, else mint one.
    // The same token is handed to the Console via the Config URL so the embedded
    // Config panel authenticates against the config-web API.
    const token = process.env.CONFIG_WEB_TOKEN || randomBytes(24).toString("base64url");

    ensureStateDir();
    // A fresh dashboard replaces any prior one — otherwise re-running would leave
    // orphaned console/config-web processes fighting over the ports.
    stopPidFile(DASH_PID_FILE);

    // Probe whether a runtime is up — Chat (7718) and Inspector (7719) are served
    // by it. "Running" = the port answers with ANY HTTP response; a refused
    // connection or timeout rejects. A short timeout keeps `dashboard` snappy.
    const probe = async (probeUrl: string): Promise<boolean> => {
      try {
        await fetch(probeUrl, { signal: AbortSignal.timeout(700) });
        return true;
      } catch {
        return false;
      }
    };
    // Pin/read the runtime surfaces' tokens so the framed Chat/Inspector panels
    // authenticate — they're served by the runtime with their own per-process token,
    // which the Console can only present if it's a stable token pinned in the config.
    const surfaces = ensureSurfaceTokens(resolve(process.cwd(), PATHS.agentsDir));
    const chatPort = surfaces.chat?.port ?? 7718;
    const inspectorPort = surfaces.inspector?.port ?? 7719;
    const chatUp = await probe(`http://127.0.0.1:${chatPort}`);
    const inspectorUp = await probe(`http://127.0.0.1:${inspectorPort}`);

    if (!chatUp && !inspectorUp) {
      console.log(`krakey: no agent is running — Chat and Inspector will show "Not connected".`);
      console.log(
        "        Start one with: krakey start    (you can still set up Krakey from the Config panel below)",
      );
    }

    // Both surfaces are DETACHED background daemons, logged to LOG_FILE and PID-
    // tracked. Detached spawn of a `--import tsx` child only runs on Windows when
    // stdio goes to a real fd (not "ignore") — mirror startBackground's pattern.
    const logFd = openSync(LOG_FILE, "a");

    // config-web (7717) — background so Config is reachable for pre-run setup.
    const cfg = spawn(process.execPath, ["--import", "tsx", configWebBin], {
      env: {
        ...process.env,
        CONFIG_WEB_PORT: "7717",
        CONFIG_WEB_HOST: "127.0.0.1",
        CONFIG_WEB_TOKEN: token,
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    cfg.unref();
    if (cfg.pid !== undefined) appendFileSync(DASH_PID_FILE, `${cfg.pid}\n`, "utf8");

    // The unified Console — also background, wired to all three surfaces. Every
    // framed URL carries its `?token=` (Config's minted here; Chat/Inspector's
    // pinned in config by ensureSurfaceTokens) so all three panels authenticate.
    const consoleChild = spawn(process.execPath, ["--import", "tsx", consoleBin], {
      env: {
        ...process.env,
        CONSOLE_PORT: port,
        CONFIG_WEB_URL: "http://127.0.0.1:7717/?token=" + encodeURIComponent(token),
        WEB_CHAT_URL: surfaceUrl(surfaces.chat, 7718),
        INSPECTOR_URL: surfaceUrl(surfaces.inspector, 7719),
      },
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    consoleChild.unref();
    if (consoleChild.pid !== undefined) appendFileSync(DASH_PID_FILE, `${consoleChild.pid}\n`, "utf8");

    console.log(`krakey: dashboard running in background (console pid ${consoleChild.pid ?? "?"}, config pid ${cfg.pid ?? "?"})`);
    console.log(`        ${url}`);
    console.log(`        log:  ${LOG_FILE}`);
    console.log(`        stop: krakey stop`);

    // Hold this process only long enough for the Console to bind, then open the
    // browser and exit — the detached daemons live on, the terminal is freed.
    await new Promise((r) => setTimeout(r, 1500));
    openBrowser(url);
    break;
  }

  case "uninstall": {
    // FULL removal: the whole install, including the repo source. This is the
    // explicit "get it off my machine" command — it cannot be undone.
    const preApproved = parsed.yes || Boolean(process.env.KRAKEY_YES);

    if (!preApproved) {
      if (!process.stdin.isTTY) {
        console.error(
          "krakey: uninstall needs confirmation but stdin is not a TTY.\n" +
            "        Re-run with --yes (or set KRAKEY_YES=1) to proceed non-interactively.",
        );
        process.exitCode = 1;
        break;
      }
      console.log("");
      console.log("!! DANGER — krakey uninstall");
      console.log("");
      console.log(`   This permanently deletes the ENTIRE OpenKrakey install at:`);
      console.log(`     ${REPO_ROOT}`);
      console.log("   including your agents, config, API keys, node_modules, AND the");
      console.log("   source code itself. This CANNOT be undone.");
      console.log("");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer: string = await new Promise((res) =>
        rl.question("   Type 'uninstall' (or y/yes) to confirm: ", (a) => res(a)),
      );
      rl.close();
      const ok = answer === "uninstall" || answer === "y" || answer === "yes";
      if (!ok) {
        console.log("krakey: aborted — nothing was removed.");
        break;
      }
    }

    // 1) Best-effort: stop any running instances first (runtime + dashboard).
    stopAll();
    stopPidFile(DASH_PID_FILE);

    // 2) Remove the PATH footprint anchored to THIS install.
    const binDir = join(REPO_ROOT, "bin");
    if (process.platform === "win32") {
      // Strip <REPO_ROOT>\bin from the User Path via a child PowerShell call.
      const psScript = [
        "$bin = [Environment]::GetEnvironmentVariable('Path','User')",
        "if ($null -eq $bin) { $bin = '' }",
        // Single-quoted PS literal: backslashes stay literal (PS escapes with `,
        // not \), so the path matches the real Path entry. Double any quote.
        `$entries = $bin.Split(';') | Where-Object { $_ -ne '' -and $_ -ne '${binDir.replace(/'/g, "''")}' }`,
        "[Environment]::SetEnvironmentVariable('Path', ($entries -join ';'), 'User')",
      ].join("; ");
      spawnSync("powershell", ["-NoProfile", "-Command", psScript], { stdio: "ignore" });
    } else {
      // Unlink any krakey symlink that points into <REPO_ROOT>/bin.
      const launcher = join(binDir, "krakey");
      for (const dir of ["/usr/local/bin", join(process.env.HOME ?? "", ".local/bin")]) {
        const link = join(dir, "krakey");
        try {
          if (lstatSync(link).isSymbolicLink() && resolve(dir, readlinkSync(link)) === launcher) {
            unlinkSync(link);
          }
        } catch {
          // Missing or unreadable — nothing to unlink.
        }
      }
    }

    // 3) Delete <REPO_ROOT> itself via a DETACHED cleaner that runs AFTER this
    //    process exits (you can't reliably delete your own running dir, esp. on
    //    Windows). The cleaner's cwd is OUTSIDE REPO_ROOT.
    console.log(`Krakey is removing itself from ${REPO_ROOT}…`);
    if (process.platform === "win32") {
      // PowerShell, not `cmd /c "… & rmdir …"`: node's cmd arg-quoting mangles
      // the nested quotes around the path. -LiteralPath with a single-quoted
      // path keeps backslashes literal and deletes the whole tree reliably.
      const psPath = REPO_ROOT.replace(/'/g, "''");
      spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Start-Sleep -Seconds 2; Remove-Item -LiteralPath '${psPath}' -Recurse -Force -ErrorAction SilentlyContinue`,
        ],
        { detached: true, stdio: "ignore", cwd: tmpdir(), windowsHide: true },
      ).unref();
    } else {
      spawn("sh", ["-c", `sleep 1; rm -rf "${REPO_ROOT}"`], {
        detached: true,
        stdio: "ignore",
        cwd: tmpdir(),
      }).unref();
    }
    process.exitCode = 0;
    break;
  }

  case "update": {
    // Pull the latest source (fast-forward only) then re-run the installer.
    if (existsSync(join(REPO_ROOT, ".git"))) {
      const git = spawnSync("git", ["pull", "--ff-only"], { cwd: REPO_ROOT, stdio: "inherit" });
      if (git.status !== 0) {
        console.warn("krakey: git pull failed (continuing to re-run the installer)");
      }
    }
    const installer =
      process.platform === "win32"
        ? spawn(
            "powershell",
            ["-ExecutionPolicy", "Bypass", "-File", join(REPO_ROOT, "install.ps1")],
            { stdio: "inherit" },
          )
        : spawn("sh", [join(REPO_ROOT, "install.sh")], { stdio: "inherit" });
    installer.on("error", (err) => {
      console.error(`krakey: failed to run installer: ${err.message}`);
      process.exitCode = 1;
    });
    installer.on("close", (code) => {
      process.exitCode = code ?? 1;
    });
    break;
  }

  case "unknown":
    console.error(`krakey: unknown command '${parsed.token}'\n\n${USAGE}`);
    process.exitCode = 1;
    break;
}
