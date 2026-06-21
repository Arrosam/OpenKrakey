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
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { PATHS } from "../../../shared/config";

import { parseCommand } from "./dispatcher";
import { createCli } from "./index";
import { runInteractiveLoop } from "./pages";

// Version comes from the repo-root package.json, resolved relative to this file
// (NOT cwd) so `krakey version` is stable wherever it is invoked from.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8"),
) as { version: string };

// Sibling bins, resolved as absolute paths from this file's location. They are
// passed as strings to the child; this worktree need not contain them.
const bootBin = fileURLToPath(new URL("../../boot/src/index.ts", import.meta.url));
const consoleBin = fileURLToPath(new URL("../../console/src/bin.ts", import.meta.url));

// The OpenKrakey install root (three levels up from packages/cli/src/bin.ts).
// Lifecycle state and the install scripts live relative to this, never cwd.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Per-install runtime state (PID list + log). Git-ignored; created on demand.
const STATE_DIR = join(REPO_ROOT, ".krakey");
const PID_FILE = join(STATE_DIR, "run.pid");
const LOG_FILE = join(STATE_DIR, "krakey.log");

const DEFAULT_DASHBOARD_PORT = "7716";

const USAGE = `usage: krakey [command]

commands:
  krakey              show this help
  krakey help         show this help
  krakey setup        open the config console (landing menu)
  krakey agent        edit agents
  krakey default      edit default settings (the template new agents copy)
  krakey providers    edit AI services (providers, endpoints, keys)
  krakey run          launch the runtime in the foreground (Ctrl+C to stop)
  krakey start        launch the runtime in the background (daemon)
  krakey stop         stop background runtime instances
  krakey dashboard    open the unified Console in your browser  [port]
  krakey uninstall    remove Krakey entirely from this machine  [--yes]
  krakey update       pull the latest version and re-run the installer
  krakey version      print the version`;

/**
 * Launch a sibling bin the way `npm test` runs tsx — `node --import tsx <bin>`.
 * The child shares this process group, so it handles Ctrl+C itself; we keep the
 * parent alive and just mirror the child's exit code. Used for FOREGROUND
 * children (run, dashboard's console server).
 */
function spawnChild(binPath: string, extraArgs: string[], env?: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, ["--import", "tsx", binPath, ...extraArgs], {
    stdio: "inherit",
    env: env ?? process.env,
  });
  process.on("SIGINT", () => {});
  child.on("error", (err) => {
    console.error(`krakey: failed to launch ${binPath}: ${err.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}

/** Ensure `.krakey/` exists so the PID list and log can be written. */
function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** Read the PID list (one pid per line), tolerating a missing/garbled file. */
function readPids(): number[] {
  if (!existsSync(PID_FILE)) return [];
  return readFileSync(PID_FILE, "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * Kill a whole process tree cross-platform, ignoring "already gone" errors.
 * On win32, taskkill /T tears down the tree. Elsewhere the detached child is a
 * process-group leader, so a negative pid signals the group; if that group is
 * gone we fall back to the bare pid. ESRCH ("no such process") is ignored.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      try {
        process.kill(pid, "SIGTERM");
      } catch (err2) {
        if ((err2 as NodeJS.ErrnoException).code !== "ESRCH") throw err2;
      }
    } else {
      throw err;
    }
  }
}

/**
 * Stop every recorded background instance and clear the PID file. Returns how
 * many were targeted. Shared by `stop` and the best-effort step of `uninstall`.
 */
function stopAll(): number {
  const pids = readPids();
  for (const pid of pids) killTree(pid);
  // Clear the list regardless — the recorded pids are no longer ours to track.
  if (existsSync(PID_FILE)) writeFileSync(PID_FILE, "", "utf8");
  return pids.length;
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
    spawnChild(bootBin, []);
    break;

  case "start": {
    // Background runtime — detach boot, log to .krakey/krakey.log, record the pid.
    ensureStateDir();
    const logFd = openSync(LOG_FILE, "a");
    const child = spawn(process.execPath, ["--import", "tsx", bootBin], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.unref();
    if (child.pid !== undefined) appendFileSync(PID_FILE, `${child.pid}\n`, "utf8");
    console.log(`krakey: started in background (pid ${child.pid ?? "?"})`);
    console.log(`        log: ${LOG_FILE}`);
    console.log("        stop with: krakey stop");
    // Return immediately — do NOT keep the parent alive for the detached child.
    break;
  }

  case "stop": {
    const stopped = stopAll();
    console.log(
      stopped === 0
        ? "krakey: no running instances"
        : `krakey: stopped ${stopped} instance${stopped === 1 ? "" : "s"}`,
    );
    break;
  }

  case "dashboard": {
    // Start the unified Console (foreground) and open it in the browser. The
    // console reads its port from CONSOLE_PORT; we mirror it for the URL.
    const port = parsed.port !== undefined ? parsed.port : DEFAULT_DASHBOARD_PORT;
    const url = `http://127.0.0.1:${port}`;
    // Give the server ~1.2s to bind before pointing the browser at it.
    setTimeout(() => openBrowser(url), 1200);
    spawnChild(consoleBin, [], { ...process.env, CONSOLE_PORT: port });
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

    // 1) Best-effort: stop any running instances first.
    stopAll();

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
      spawn(
        "cmd",
        ["/c", `ping 127.0.0.1 -n 3 >nul & rmdir /s /q "${REPO_ROOT}"`],
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
