/**
 * cli — pure config-file core.
 *
 * The implementation now lives in `shared/config-ops` so BOTH config tools — this
 * interactive cli and the `config-web` UI — drive the exact same fs operations
 * (no drift, no node-to-node import). This module re-exports that surface so the
 * shell (./pages, ./bin) keeps importing from "./index" unchanged.
 */
export {
  CliError,
  CliParseError,
  normalizeBaseURL,
  createCli,
} from "../../../shared/config-ops";
export type { Cli } from "../../../shared/config-ops";
