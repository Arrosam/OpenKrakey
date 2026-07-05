/**
 * Black-box edge tests for the `cli` node's SUPERVISOR helpers — the pure,
 * dependency-injected primitives behind `krakey run` (auto-relaunch on a
 * graceful restart) and `krakey start`/`stop` (the pid-file daemon supervisor).
 *
 * LOCKED MODULE SURFACE — `packages/cli/src/supervisor.ts` will export EXACTLY:
 *
 *   superviseLoop(
 *     launch: () => Promise<number | null>,
 *     opts?: {
 *       restartDelayMs?: number;
 *       sleep?: (ms: number) => Promise<void>;
 *       onRestart?: () => void;
 *     },
 *   ): Promise<number>
 *     — awaits launch(); while the resolved code === RESTART_EXIT_CODE call
 *       opts.onRestart?.(), await opts.sleep?.(restartDelayMs ?? 300) (the
 *       default sleep is a real setTimeout), then launch() again; the first
 *       non-restart code resolves the loop. A resolved `null` coerces to 1.
 *
 *   isAlive(pid: number): boolean
 *     — process.kill(pid, 0) probe; ESRCH => false; any other error (incl.
 *       EPERM) => true.
 *
 *   stopPidFile(
 *     file: string,
 *     deps?: { isAlive?: (pid: number) => boolean; killTree?: (pid: number) => void },
 *   ): { targeted: number; alive: number }
 *     — reads whitespace/newline-separated pids (missing file => {0,0}); for
 *       each pid, calls killTree ONLY when isAlive; ALWAYS truncates the file
 *       afterwards (writes ''). targeted = pids recorded; alive = pids killed.
 *
 *   rotateLog(file: string): void
 *     — if the file exists, renameSync(file, file + '.old') overwriting any
 *       existing .old; on rename failure it warns and returns WITHOUT throwing
 *       (file left in place); a no-op when the file is absent.
 *
 * The module does NOT exist yet — the dev agent creates it. This import will
 * therefore fail (module-not-found) until dev lands; that is expected and is the
 * whole point of contract-first tests. Do NOT stub it.
 *
 * RESTART_EXIT_CODE is pinned via the shared/config import — never the literal 75.
 *
 * Isolation: loop tests use INJECTED fakes (never spawn a real process for the
 * relaunch behavior); fs tests use a fresh per-test OS temp dir. isAlive's dead
 * path is validated against a REAL short-lived child we spawn and reap, so the
 * ESRCH probe is exercised on THIS platform.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { RESTART_EXIT_CODE } from "../shared/config";
import { superviseLoop, isAlive, stopPidFile, rotateLog } from "../packages/cli/src/supervisor";

// ---------------------------------------------------------------------------
// per-test temp sandbox
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-cli-sup-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A never-real sleep: records each requested delay, resolves immediately. */
function recordingSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: async (ms: number) => {
      calls.push(ms);
    },
  };
}

/**
 * A launch() fake that resolves the given codes in order, one per call, and
 * records how many times it was invoked. Resolving PAST the scripted list is a
 * test bug (the loop asked for more launches than we planned) — throw loudly.
 */
function scriptedLaunch(codes: Array<number | null>): {
  fn: () => Promise<number | null>;
  count: () => number;
} {
  let i = 0;
  return {
    count: () => i,
    fn: async () => {
      if (i >= codes.length) {
        throw new Error(`launch() called ${i + 1} times but only ${codes.length} code(s) scripted`);
      }
      return codes[i++];
    },
  };
}

/** Absolute path to a pid-file inside this test's temp dir. */
function pidFilePath(name = "krakey.pid"): string {
  return path.join(tmp, name);
}

/** A killTree fake that records every pid it was asked to kill. */
function recordingKillTree(): { fn: (pid: number) => void; killed: number[] } {
  const killed: number[] = [];
  return { killed, fn: (pid: number) => killed.push(pid) };
}

/**
 * Spawn a real, trivially-short-lived node child, wait for it to exit, and
 * return its (now-dead) pid. Used ONLY to obtain a pid guaranteed to be gone so
 * isAlive's ESRCH path is exercised for real on this OS.
 */
function spawnAndReapDeadPid(): number {
  const res = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.equal(res.status, 0, "the throwaway child exited cleanly");
  assert.ok(typeof res.pid === "number" && res.pid > 0, "the child reported a pid");
  return res.pid as number;
}

// ===========================================================================
// superviseLoop
// ===========================================================================

// -------- positive: the relaunch happy path --------------------------------

test("superviseLoop: RESTART code relaunches once then a normal code resolves it", async () => {
  // 75 (restart) then 0 (terminal) => launch twice, resolve 0.
  const launch = scriptedLaunch([RESTART_EXIT_CODE, 0]);
  const sleep = recordingSleep();
  let restarts = 0;

  const code = await superviseLoop(launch.fn, {
    sleep: sleep.fn,
    onRestart: () => {
      restarts++;
    },
  });

  assert.equal(code, 0, "the first non-restart code resolves the loop");
  assert.equal(launch.count(), 2, "launched exactly twice (initial + one relaunch)");
  assert.equal(restarts, 1, "onRestart fired exactly once");
});

test("superviseLoop: default restart delay is 300ms (passed to the injected sleep)", async () => {
  const launch = scriptedLaunch([RESTART_EXIT_CODE, 0]);
  const sleep = recordingSleep();

  await superviseLoop(launch.fn, { sleep: sleep.fn });

  assert.deepEqual(sleep.calls, [300], "one sleep of the default 300ms before the relaunch");
});

test("superviseLoop: a custom restartDelayMs overrides the default and is forwarded to sleep", async () => {
  const launch = scriptedLaunch([RESTART_EXIT_CODE, 0]);
  const sleep = recordingSleep();

  await superviseLoop(launch.fn, { sleep: sleep.fn, restartDelayMs: 42 });

  assert.deepEqual(sleep.calls, [42], "the passed restartDelayMs is used verbatim");
});

test("superviseLoop: multiple consecutive RESTART codes relaunch each time", async () => {
  // restart, restart, restart, then 0 => four launches, three restarts.
  const launch = scriptedLaunch([RESTART_EXIT_CODE, RESTART_EXIT_CODE, RESTART_EXIT_CODE, 0]);
  const sleep = recordingSleep();
  let restarts = 0;

  const code = await superviseLoop(launch.fn, {
    sleep: sleep.fn,
    restartDelayMs: 5,
    onRestart: () => {
      restarts++;
    },
  });

  assert.equal(code, 0);
  assert.equal(launch.count(), 4, "initial + three relaunches");
  assert.equal(restarts, 3, "onRestart once per relaunch");
  assert.deepEqual(sleep.calls, [5, 5, 5], "one sleep per relaunch");
});

// -------- negative / no-relaunch: any non-restart code is terminal ---------

test("superviseLoop: a normal 0 exit does NOT relaunch (launch once, resolve 0)", async () => {
  const launch = scriptedLaunch([0]);
  const sleep = recordingSleep();
  let restarts = 0;

  const code = await superviseLoop(launch.fn, {
    sleep: sleep.fn,
    onRestart: () => {
      restarts++;
    },
  });

  assert.equal(code, 0);
  assert.equal(launch.count(), 1, "no relaunch on a clean exit");
  assert.equal(restarts, 0, "onRestart never fired");
  assert.deepEqual(sleep.calls, [], "sleep never called");
});

test("superviseLoop: a non-zero, non-restart code is terminal and propagates unchanged", async () => {
  const launch = scriptedLaunch([3]);
  const sleep = recordingSleep();

  const code = await superviseLoop(launch.fn, { sleep: sleep.fn });

  assert.equal(code, 3, "an ordinary failure code is returned as-is, not swallowed");
  assert.equal(launch.count(), 1, "a terminal failure does not relaunch");
});

test("superviseLoop: a resolved null coerces to exit code 1 (no relaunch)", async () => {
  const launch = scriptedLaunch([null]);
  const sleep = recordingSleep();
  let restarts = 0;

  const code = await superviseLoop(launch.fn, {
    sleep: sleep.fn,
    onRestart: () => {
      restarts++;
    },
  });

  assert.equal(code, 1, "null (signalled / unknown) becomes 1");
  assert.equal(launch.count(), 1, "null is terminal, not a restart");
  assert.equal(restarts, 0);
});

// -------- BVA around the restart sentinel ----------------------------------

test("superviseLoop: RESTART_EXIT_CODE - 1 is terminal (only the exact sentinel relaunches)", async () => {
  const below = RESTART_EXIT_CODE - 1;
  const launch = scriptedLaunch([below]);
  const sleep = recordingSleep();

  const code = await superviseLoop(launch.fn, { sleep: sleep.fn });

  assert.equal(code, below, "one below the sentinel is an ordinary terminal code");
  assert.equal(launch.count(), 1, "no relaunch just below the sentinel");
});

test("superviseLoop: RESTART_EXIT_CODE + 1 is terminal (only the exact sentinel relaunches)", async () => {
  const above = RESTART_EXIT_CODE + 1;
  const launch = scriptedLaunch([above]);
  const sleep = recordingSleep();

  const code = await superviseLoop(launch.fn, { sleep: sleep.fn });

  assert.equal(code, above, "one above the sentinel is an ordinary terminal code");
  assert.equal(launch.count(), 1, "no relaunch just above the sentinel");
});

// -------- optional-arg / boundary: absent callbacks + zero delay -----------

test("superviseLoop: works with NO opts at all on a terminal first launch (default sleep never invoked)", async () => {
  // With a terminal first code the default real-setTimeout sleep is never
  // reached, so this stays fast and needs no injection.
  const launch = scriptedLaunch([0]);
  const code = await superviseLoop(launch.fn);
  assert.equal(code, 0);
  assert.equal(launch.count(), 1);
});

test("superviseLoop: onRestart is optional — a relaunch cycle runs fine when it is omitted", async () => {
  const launch = scriptedLaunch([RESTART_EXIT_CODE, 0]);
  const sleep = recordingSleep();

  // No onRestart provided; must not throw on the restart branch.
  const code = await superviseLoop(launch.fn, { sleep: sleep.fn });

  assert.equal(code, 0);
  assert.equal(launch.count(), 2);
  assert.deepEqual(sleep.calls, [300]);
});

test("superviseLoop: restartDelayMs of 0 is honoured (boundary: falsy-but-valid delay)", async () => {
  const launch = scriptedLaunch([RESTART_EXIT_CODE, 0]);
  const sleep = recordingSleep();

  await superviseLoop(launch.fn, { sleep: sleep.fn, restartDelayMs: 0 });

  // 0 must NOT be treated as "unset" and replaced by 300.
  assert.deepEqual(sleep.calls, [0], "a zero delay is forwarded verbatim, not defaulted to 300");
});

test("superviseLoop: onRestart fires BEFORE the sleep on each relaunch", async () => {
  const order: string[] = [];
  const launch = scriptedLaunch([RESTART_EXIT_CODE, 0]);

  await superviseLoop(launch.fn, {
    onRestart: () => order.push("onRestart"),
    sleep: async () => {
      order.push("sleep");
    },
  });

  assert.deepEqual(order, ["onRestart", "sleep"], "notify first, then back off, then relaunch");
});

// ===========================================================================
// isAlive
// ===========================================================================

test("isAlive: the current process is alive", () => {
  assert.equal(isAlive(process.pid), true, "our own pid must probe alive");
});

test("isAlive: a reaped child's pid is NOT alive (real ESRCH path on this OS)", () => {
  const deadPid = spawnAndReapDeadPid();
  assert.equal(isAlive(deadPid), false, "a pid whose process has exited probes dead (ESRCH)");
});

test("isAlive: pid 0 is treated as alive (kill(0,0) targets the group, never ESRCH)", () => {
  // Boundary: pid 0 is a special signalling target; process.kill(0, 0) does not
  // raise ESRCH, so per the contract (anything-but-ESRCH => true) it reads alive.
  assert.equal(isAlive(0), true);
});

// ===========================================================================
// stopPidFile
// ===========================================================================

// -------- positive: mixed alive/dead, kill only the living ----------------

test("stopPidFile: one alive + one dead pid -> {targeted:2, alive:1}, kills only the alive one, truncates the file", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "111\n222\n", "utf8");

  const kill = recordingKillTree();
  // 111 alive, 222 dead.
  const res = stopPidFile(file, { isAlive: (pid) => pid === 111, killTree: kill.fn });

  assert.deepEqual(res, { targeted: 2, alive: 1 }, "two recorded, one actually alive/killed");
  assert.deepEqual(kill.killed, [111], "killTree called ONLY for the alive pid");
  assert.equal(fs.readFileSync(file, "utf8"), "", "the pid file is truncated to empty afterwards");
});

test("stopPidFile: all pids alive -> alive === targeted, every pid killed", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "10 20 30", "utf8"); // space-separated on one line

  const kill = recordingKillTree();
  const res = stopPidFile(file, { isAlive: () => true, killTree: kill.fn });

  assert.deepEqual(res, { targeted: 3, alive: 3 });
  assert.deepEqual(kill.killed.sort((a, b) => a - b), [10, 20, 30], "all three killed");
  assert.equal(fs.readFileSync(file, "utf8"), "");
});

test("stopPidFile: all pids dead -> {targeted:N, alive:0}, killTree never called, file still truncated", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "7\n8\n9\n", "utf8");

  const kill = recordingKillTree();
  const res = stopPidFile(file, { isAlive: () => false, killTree: kill.fn });

  assert.deepEqual(res, { targeted: 3, alive: 0 });
  assert.deepEqual(kill.killed, [], "nothing living to kill");
  assert.equal(fs.readFileSync(file, "utf8"), "", "the stale file is cleaned up regardless");
});

test("stopPidFile: whitespace/newline-separated pids parse across mixed separators", () => {
  const file = pidFilePath();
  // A deliberately messy mix: CRLF, LF, tabs, multiple spaces, trailing newline.
  fs.writeFileSync(file, "1\r\n2\t3   4\n\n5\n", "utf8");

  const kill = recordingKillTree();
  const res = stopPidFile(file, { isAlive: () => true, killTree: kill.fn });

  assert.equal(res.targeted, 5, "all five pids recovered despite mixed whitespace");
  assert.deepEqual(kill.killed.sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

// -------- BVA: empty file, single pid --------------------------------------

test("stopPidFile: a single-pid file -> {targeted:1, alive:1} when alive", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "4242\n", "utf8");

  const kill = recordingKillTree();
  const res = stopPidFile(file, { isAlive: () => true, killTree: kill.fn });

  assert.deepEqual(res, { targeted: 1, alive: 1 });
  assert.deepEqual(kill.killed, [4242]);
});

test("stopPidFile: an EMPTY (but existing) pid file -> {targeted:0, alive:0}, no kill, no throw", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "", "utf8");

  const kill = recordingKillTree();
  let res: { targeted: number; alive: number } | undefined;
  assert.doesNotThrow(() => {
    res = stopPidFile(file, { isAlive: () => true, killTree: kill.fn });
  });

  assert.deepEqual(res, { targeted: 0, alive: 0 }, "no pids recorded in an empty file");
  assert.deepEqual(kill.killed, []);
});

test("stopPidFile: a whitespace-ONLY file -> {targeted:0, alive:0} (no phantom pids)", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "  \n\t \r\n  ", "utf8");

  const kill = recordingKillTree();
  const res = stopPidFile(file, { isAlive: () => true, killTree: kill.fn });

  assert.deepEqual(res, { targeted: 0, alive: 0 }, "whitespace between separators yields no pids");
  assert.deepEqual(kill.killed, []);
});

// -------- negative: missing file --------------------------------------------

test("stopPidFile: a MISSING pid file -> {targeted:0, alive:0}, no throw, no kill", () => {
  const file = pidFilePath("does-not-exist.pid");
  assert.equal(fs.existsSync(file), false, "precondition: the file truly does not exist");

  const kill = recordingKillTree();
  let res: { targeted: number; alive: number } | undefined;
  assert.doesNotThrow(() => {
    res = stopPidFile(file, { isAlive: () => true, killTree: kill.fn });
  });

  assert.deepEqual(res, { targeted: 0, alive: 0 });
  assert.deepEqual(kill.killed, [], "nothing to target when the file is absent");
});

// -------- state transition: idempotent stop --------------------------------

test("stopPidFile: calling twice is idempotent — the second call sees an empty file", () => {
  const file = pidFilePath();
  fs.writeFileSync(file, "500\n600\n", "utf8");

  const kill1 = recordingKillTree();
  const first = stopPidFile(file, { isAlive: () => true, killTree: kill1.fn });
  assert.deepEqual(first, { targeted: 2, alive: 2 });
  assert.deepEqual(kill1.killed.sort((a, b) => a - b), [500, 600]);

  // The file was truncated by the first call; a second stop targets nothing.
  const kill2 = recordingKillTree();
  const second = stopPidFile(file, { isAlive: () => true, killTree: kill2.fn });
  assert.deepEqual(second, { targeted: 0, alive: 0 }, "second stop is a no-op — file already cleared");
  assert.deepEqual(kill2.killed, [], "no pids to re-kill after the first stop");
});

// ===========================================================================
// rotateLog
// ===========================================================================

// -------- positive / negative: absent file is a no-op ----------------------

test("rotateLog: absent file is a no-op — no throw, no .old created", () => {
  const file = pidFilePath("krakey.log");
  assert.equal(fs.existsSync(file), false, "precondition: no log file");

  assert.doesNotThrow(() => rotateLog(file));
  assert.equal(fs.existsSync(file + ".old"), false, "no .old should be conjured from nothing");
});

// -------- positive: rename existing -> .old --------------------------------

test("rotateLog: an existing log is renamed to <file>.old (original gone, .old carries the content)", () => {
  const file = path.join(tmp, "krakey.log");
  fs.writeFileSync(file, "fresh log content", "utf8");

  rotateLog(file);

  assert.equal(fs.existsSync(file), false, "the original file is moved away");
  assert.equal(fs.existsSync(file + ".old"), true, "the rotated file exists");
  assert.equal(fs.readFileSync(file + ".old", "utf8"), "fresh log content", "content preserved in .old");
});

test("rotateLog: overwrites a PRE-EXISTING .old — only the newest content survives", () => {
  const file = path.join(tmp, "krakey.log");
  fs.writeFileSync(file + ".old", "STALE previous rotation", "utf8");
  fs.writeFileSync(file, "the current run's log", "utf8");

  rotateLog(file);

  assert.equal(fs.existsSync(file), false, "current log moved away");
  assert.equal(
    fs.readFileSync(file + ".old", "utf8"),
    "the current run's log",
    "the old .old is overwritten by the rotated current log",
  );
});

// -------- state transition: rotate twice -----------------------------------

test("rotateLog: rotating twice — the 2nd rotate is a no-op once the current log is gone", () => {
  const file = path.join(tmp, "krakey.log");
  fs.writeFileSync(file, "run one", "utf8");

  rotateLog(file);
  assert.equal(fs.readFileSync(file + ".old", "utf8"), "run one");
  assert.equal(fs.existsSync(file), false);

  // No current log now => second rotate must not touch or clobber the .old.
  assert.doesNotThrow(() => rotateLog(file));
  assert.equal(fs.readFileSync(file + ".old", "utf8"), "run one", ".old is untouched when there is nothing to rotate");
});

// -------- negative: rename failure is swallowed -----------------------------

test("rotateLog: a rename FAILURE is swallowed — warns, does not throw, leaves the original in place", () => {
  const file = path.join(tmp, "krakey.log");
  fs.writeFileSync(file, "cannot be rotated", "utf8");
  // Force renameSync(file, file + '.old') to fail cross-platform: make the
  // destination an existing NON-EMPTY DIRECTORY. renameSync onto a populated
  // directory raises ENOTEMPTY/EEXIST/EISDIR (platform-dependent) — the point is
  // it throws, and rotateLog must catch it.
  const oldDir = file + ".old";
  fs.mkdirSync(oldDir);
  fs.writeFileSync(path.join(oldDir, "occupant"), "blocks the rename", "utf8");

  assert.doesNotThrow(() => rotateLog(file), "rename failure must be caught, not propagated");

  // The original log is left in place (not lost) when rotation fails.
  assert.equal(fs.existsSync(file), true, "the original log survives a failed rotation");
  assert.equal(fs.readFileSync(file, "utf8"), "cannot be rotated", "and its content is intact");
});
