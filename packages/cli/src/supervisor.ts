/**
 * cli — supervisor helpers. Pure, side-effect-injectable primitives the bin
 * shell uses to (1) keep the runtime alive across self-restarts, (2) kill and
 * clear a PID-list file, (3) probe whether a pid is still live, and (4) rotate
 * the daemon log at each `krakey start`.
 *
 * Everything here is written so the process-touching bits (sleep, kill, alive
 * check) can be injected in tests; the DEFAULTS are the real, side-effecting
 * implementations bin.ts relies on in production.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

import { RESTART_EXIT_CODE } from "../../../shared/config";

/** Real sleep: resolve after `ms` via a single setTimeout. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drive a self-restarting launch. Awaits `launch()`; while the resolved code is
 * RESTART_EXIT_CODE, call `onRestart` FIRST, then sleep `restartDelayMs` (default
 * 300 — `??` so 0 is honoured), then relaunch. The first non-restart code
 * resolves the loop verbatim; a null code resolves as 1.
 */
export async function superviseLoop(
  launch: () => Promise<number | null>,
  opts?: {
    restartDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRestart?: () => void;
  },
): Promise<number> {
  const sleep = opts?.sleep ?? defaultSleep;
  const delay = opts?.restartDelayMs ?? 300;
  let code = await launch();
  while (code === RESTART_EXIT_CODE) {
    opts?.onRestart?.();
    await sleep(delay);
    code = await launch();
  }
  return code ?? 1;
}

/**
 * True if a process with `pid` exists. `kill(pid, 0)` sends no signal — it only
 * probes. ESRCH ("no such process") is the only definitive "dead"; EPERM (exists
 * but not ours) and anything else read as alive. Note pid 0 targets the current
 * process group, so it reads alive.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Kill a whole process tree cross-platform, ignoring "already gone" errors.
 * On win32, taskkill /T tears down the tree. Elsewhere the detached child is a
 * process-group leader, so a negative pid signals the group; if that group is
 * gone we fall back to the bare pid. ESRCH ("no such process") is ignored.
 */
export function realKillTree(pid: number): void {
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
 * Kill every pid recorded in `file`, then clear the file. Returns how many pids
 * were recorded (`targeted`) and how many of those were still live when checked
 * (`alive`). A missing file is a no-op returning {targeted:0, alive:0}. The pid
 * list is parsed on any whitespace; empty/NaN tokens are dropped (a whitespace-
 * only file yields zero pids). The file is always truncated when it existed.
 */
export function stopPidFile(
  file: string,
  deps?: { isAlive?: (pid: number) => boolean; killTree?: (pid: number) => void },
): { targeted: number; alive: number } {
  if (!existsSync(file)) return { targeted: 0, alive: 0 };
  const aliveCheck = deps?.isAlive ?? isAlive;
  const kill = deps?.killTree ?? realKillTree;
  const pids = readFileSync(file, "utf8")
    .split(/\s+/)
    .map((tok) => Number(tok))
    .filter((n) => Number.isInteger(n) && n > 0);
  let alive = 0;
  for (const pid of pids) {
    if (aliveCheck(pid)) {
      kill(pid);
      alive++;
    }
  }
  writeFileSync(file, "", "utf8");
  return { targeted: pids.length, alive };
}

/**
 * Rotate `file` to `file + ".old"` (overwriting any existing .old) if it exists.
 * A failed rename (.old is a directory, EBUSY, EPERM, …) is warned about on one
 * line and swallowed — the log stays in place rather than crashing the daemon
 * launch. Absent file is a silent no-op (no throw, no .old created).
 */
export function rotateLog(file: string): void {
  if (!existsSync(file)) return;
  try {
    renameSync(file, file + ".old");
  } catch (err) {
    console.warn(`krakey: could not rotate log ${file}: ${(err as Error).message}`);
  }
}
