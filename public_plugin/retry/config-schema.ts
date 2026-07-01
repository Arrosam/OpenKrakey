/**
 * Pure-data config schema for the `retry` plugin. Imports ONLY the ConfigSchema
 * type so config tools (cli, config-web) can read it without running the plugin.
 */
import type { ConfigSchema } from "../../contracts/plugin";

export const RETRY_SCHEMA: ConfigSchema = [
  {
    key: "retryIntervalMs",
    label: "Retry interval (ms)",
    type: "number",
    default: 15000,
    min: 1,
    step: 1000,
    unit: "ms",
    help: "How soon to wake after a failed LLM round-trip (15000 = 15s).",
  },
  {
    key: "backoff",
    label: "Exponential backoff",
    type: "boolean",
    default: false,
    help: "Double the retry interval after each consecutive failure (capped).",
  },
  {
    key: "maxRetryIntervalMs",
    label: "Max retry interval (ms)",
    type: "number",
    default: 120000,
    min: 1,
    step: 1000,
    unit: "ms",
    showIf: { key: "backoff", equals: true },
    help: "Cap for exponential backoff.",
  },
  {
    key: "maxConsecutiveRetries",
    label: "Max consecutive retries",
    type: "number",
    default: 0,
    min: 0,
    step: 1,
    help: "Stop shortening after this many consecutive failures (0 = unlimited).",
  },
  {
    key: "logRetries",
    label: "Log retries",
    type: "boolean",
    default: true,
    help: "Log a line each time the interval is shortened.",
  },
];
