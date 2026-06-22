/**
 * cli — the pure argv parser. Maps `process.argv.slice(2)` to a discriminated
 * command for bin.ts to act on. NO process / fs / spawn — a pure function of its
 * argv array, so it is unit-testable in isolation. bin.ts is the only place that
 * reads process.* and turns these commands into I/O.
 *
 * Recognition is case-sensitive with no trimming/normalization, so "Start",
 * "HELP", "-V" and "  start" are all `unknown`. The empty argv array (length 0)
 * is help (the usage landing), but `[""]` (argv[0] is the empty string) is
 * unknown — hence the length check happens BEFORE switching on argv[0].
 */
export type ParsedCommand =
  | { kind: "setup"; page: "landing" | "agents" | "default" | "providers" }
  | { kind: "run" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "restart" }
  | { kind: "dashboard"; port: string | undefined }
  | { kind: "uninstall"; yes: boolean }
  | { kind: "update" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "unknown"; token: string };

/** Parse process.argv.slice(2) into a discriminated command. Pure. */
export function parseCommand(argv: string[]): ParsedCommand {
  // No tokens at all → help (the usage landing). Distinct from `[""]`, whose
  // argv[0] is a present-but-unmatched empty string and so is `unknown`.
  if (argv.length === 0) return { kind: "help" };

  const token = argv[0];
  switch (token) {
    case "setup":
      return { kind: "setup", page: "landing" };
    case "agent":
      return { kind: "setup", page: "agents" };
    case "default":
      return { kind: "setup", page: "default" };
    case "providers":
      return { kind: "setup", page: "providers" };
    case "run":
      return { kind: "run" };
    case "start":
      return { kind: "start" };
    case "stop":
      return { kind: "stop" };
    case "restart":
      return { kind: "restart" };
    case "dashboard":
      // argv[1] is the RAW port string (no numeric validation here); absent → undefined.
      return { kind: "dashboard", port: argv[1] };
    case "uninstall":
      // The confirmation gate can be pre-answered with --yes / -y anywhere in argv.
      return { kind: "uninstall", yes: argv.includes("--yes") || argv.includes("-y") };
    case "update":
      return { kind: "update" };
    case "help":
    case "--help":
    case "-h":
      return { kind: "help" };
    case "version":
    case "--version":
    case "-v":
      return { kind: "version" };
    default:
      return { kind: "unknown", token };
  }
}
