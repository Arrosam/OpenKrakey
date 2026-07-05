#!/usr/bin/env -S tsx
/**
 * cli — supervisor entry. The long-lived process `krakey start` detaches: it
 * launches the boot runtime as a normal child (inheriting THIS process's stdio,
 * which the daemon spawn already wired to the log fds) and relaunches it whenever
 * boot exits with RESTART_EXIT_CODE. Any other exit code is terminal and is
 * propagated as this process's exit code.
 *
 * No SIGTERM/SIGINT handlers are installed on purpose — `krakey stop` kills the
 * whole tree, and dying immediately on a signal is exactly what we want.
 */
import { spawn } from "node:child_process";

import { superviseLoop } from "./supervisor";

/** Pull `--boot <path>` out of argv. */
function parseBootPath(argv: string[]): string | undefined {
  const i = argv.indexOf("--boot");
  if (i === -1) return undefined;
  return argv[i + 1];
}

const parsedBoot = parseBootPath(process.argv.slice(2));
if (parsedBoot === undefined) {
  console.error("krakey supervisor: missing --boot <path>");
  process.exit(1);
}
const bootPath: string = parsedBoot;

/** Launch boot as a normal child and resolve its exit code. */
function launch(): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", bootPath], {
      stdio: "inherit",
      detached: false,
    });
    child.on("error", (err) => {
      console.error(`krakey supervisor: failed to launch boot: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code));
  });
}

const code = await superviseLoop(launch);
process.exit(code);
