/**
 * shared/config-ops — pure, fs-only config operations.
 *
 * The single config-file surface, shared by every config TOOL: the interactive
 * `cli` (packages/cli) and the `config-web` UI (packages/config-web) both build
 * on this. It was extracted verbatim from packages/cli/src/index.ts so the two
 * tools read/write agent configs, the Default Setting, and the LLM catalogue
 * identically — no drift, no node-to-node import.
 *
 * Every operation is a plain async method over `node:fs/promises`. Paths in
 * `deps` are already absolute (the caller resolves them from PATHS). This module
 * resolves nothing; it only joins agent ids onto `agentsDir` via the shared
 * `agentPaths` helper. NO `@inquirer/prompts`, NO process/runtime state.
 */
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentDefinition } from "../../contracts/agent";
import type {
  DefaultAgentSetting,
  LLMConfig,
} from "../config";
import { agentPaths } from "../config";

/** Thrown for every expected, user-facing failure (missing files, bad JSON, …). */
export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliError";
  }
}

/** Thrown when a file EXISTS but holds invalid JSON (distinct from "absent"). */
export class CliParseError extends CliError {
  constructor(message: string) {
    super(message);
    this.name = "CliParseError";
  }
}

/**
 * Clean a user-entered baseURL: trim whitespace, strip ALL trailing slashes
 * (adapters append their own paths — a trailing slash would yield `//chat/…`).
 * Returns undefined when nothing usable remains, meaning "no override, use the
 * provider's default endpoint".
 */
export function normalizeBaseURL(raw: string): string | undefined {
  const cleaned = raw.trim().replace(/\/+$/, "");
  return cleaned === "" ? undefined : cleaned;
}

/** The pure config-file surface the interactive shell drives. */
export interface Cli {
  /** Agent ids that have a config.json, sorted. Missing dir → []. */
  listAgents(): Promise<string[]>;
  /** Parse one agent's config.json. Missing / invalid → CliError. */
  readAgent(id: string): Promise<AgentDefinition>;
  /** Seed a new agent's config from the Default Plugin Setting. */
  createAgent(id: string): Promise<void>;
  /** Write (overwrite) an agent's config.json. */
  writeAgent(id: string, def: AgentDefinition): Promise<void>;
  /** Delete an agent's config.json ONLY (folder + plugin data kept). */
  removeAgent(id: string): Promise<void>;
  /** Parse the Default Plugin Setting. Missing → CliError. */
  readDefault(): Promise<DefaultAgentSetting>;
  /** Write (overwrite) the Default Plugin Setting. */
  writeDefault(setting: DefaultAgentSetting): Promise<void>;
  /** Available public plugin ids (subdirs), sorted. Missing dir → []. */
  listAvailablePlugins(): Promise<string[]>;
  /** Parse the LLM catalogue. Missing → { communicators: {} }. */
  readLLMConfig(): Promise<LLMConfig>;
  /** Write (overwrite) the LLM catalogue. */
  writeLLMConfig(cfg: LLMConfig): Promise<void>;
  /** Communicator names from the LLM catalogue, sorted. */
  listCommunicators(): Promise<string[]>;
}

interface CliDeps {
  /** Absolute path to agents/ (per-Agent folders live under here). */
  agentsDir: string;
  /** Absolute path to the Default Plugin Setting file. */
  defaultPath: string;
  /** Absolute path to the public plugin code dir. */
  publicPluginDir: string;
  /** Absolute path to the LLM catalogue (config/llm.json). */
  llmPath: string;
  /** Output sink (defaults to console.log). */
  out?: (msg: string) => void;
}

const PRETTY = 2;

const isErrno = (err: unknown): err is NodeJS.ErrnoException =>
  err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";

const isENOENT = (err: unknown): boolean => isErrno(err) && err.code === "ENOENT";

/** List immediate subdirectory names of `dir`, sorted. ENOENT → []. */
async function listSubdirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** True when `dir` holds a plugin entry point (index.ts or index.js). */
async function hasPluginEntry(dir: string): Promise<boolean> {
  for (const entry of ["index.ts", "index.js"]) {
    try {
      await access(join(dir, entry));
      return true;
    } catch {
      // entry absent — try the next
    }
  }
  return false;
}

/** Read + JSON.parse a file. ENOENT → undefined; parse error → CliParseError(badJsonMsg). */
async function readJson<T>(
  path: string,
  badJsonMsg: string,
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (isENOENT(err)) return undefined;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliParseError(badJsonMsg);
  }
}

/** Reject ids that can't be a single safe folder name (before any fs access). */
function assertValidAgentId(id: string): void {
  if (id.trim().length === 0 || id === "." || id === ".." || /[/\\\s]/.test(id)) {
    throw new CliError(`invalid agent id "${id}"`);
  }
}

/** mkdir -p the parent dir, then write `value` as pretty JSON. */
async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, PRETTY));
}

export function createCli(deps: CliDeps): Cli {
  const { agentsDir, defaultPath, publicPluginDir, llmPath } = deps;
  // `out` is retained for symmetry with the interface/spec; core ops surface
  // results via return values + CliError rather than printing.
  void deps.out;

  const paths = (id: string) => agentPaths(agentsDir, id);

  const readDefault = async (): Promise<DefaultAgentSetting> => {
    const setting = await readJson<DefaultAgentSetting>(
      defaultPath,
      `Default setting at "${defaultPath}" is not valid JSON`,
    );
    if (setting !== undefined) return setting;
    // No live default yet (fresh install / after a reset) — fall back to the
    // committed template (`agent.default.example.json`) so the UI shows the
    // SHIPPED defaults instead of an empty form. Saving writes the live file.
    const examplePath = defaultPath.replace(/\.json$/, ".example.json");
    const example = await readJson<DefaultAgentSetting>(
      examplePath,
      `Default setting template at "${examplePath}" is not valid JSON`,
    );
    if (example !== undefined) return example;
    throw new CliError(`No default setting found at "${defaultPath}"`);
  };

  const readLLMConfig = async (): Promise<LLMConfig> => {
    const cfg = await readJson<LLMConfig>(
      llmPath,
      `LLM config at "${llmPath}" is not valid JSON`,
    );
    if (cfg === undefined) return { communicators: {} };
    if (cfg.communicators === undefined || cfg.communicators === null) {
      return { ...cfg, communicators: {} };
    }
    return cfg;
  };

  return {
    async listAgents(): Promise<string[]> {
      const ids = await listSubdirs(agentsDir);
      const present: string[] = [];
      for (const id of ids) {
        const config = paths(id).config;
        try {
          await readFile(config);
          present.push(id);
        } catch (err) {
          if (isENOENT(err)) continue;
          throw err;
        }
      }
      return present.sort();
    },

    async readAgent(id: string): Promise<AgentDefinition> {
      assertValidAgentId(id);
      const config = paths(id).config;
      const def = await readJson<AgentDefinition>(
        config,
        `Agent "${id}" config is not valid JSON`,
      );
      if (def === undefined) {
        throw new CliError(`Agent "${id}" not found`);
      }
      return def;
    },

    async createAgent(id: string): Promise<void> {
      assertValidAgentId(id);
      const { dir, config } = paths(id);
      try {
        await readFile(config);
        throw new CliError(`Agent "${id}" already exists`);
      } catch (err) {
        if (err instanceof CliError) throw err;
        if (!isENOENT(err)) throw err;
        // ENOENT → free to create.
      }

      let setting: DefaultAgentSetting;
      try {
        setting = await readDefault();
      } catch (err) {
        if (err instanceof CliError) {
          throw new CliError(
            `No default setting found at "${defaultPath}" — create one first`,
          );
        }
        throw err;
      }

      const def: AgentDefinition = { ...setting, id };
      await mkdir(dir, { recursive: true });
      await writeFile(config, JSON.stringify(def, null, PRETTY));
    },

    async writeAgent(id: string, def: AgentDefinition): Promise<void> {
      assertValidAgentId(id);
      const { dir, config } = paths(id);
      await mkdir(dir, { recursive: true });
      await writeFile(config, JSON.stringify(def, null, PRETTY));
    },

    async removeAgent(id: string): Promise<void> {
      assertValidAgentId(id);
      await rm(paths(id).config, { force: true });
    },

    readDefault,

    async writeDefault(setting: DefaultAgentSetting): Promise<void> {
      await writeJson(defaultPath, setting);
    },

    async listAvailablePlugins(): Promise<string[]> {
      // Only dirs with an index.ts/index.js entry are loadable plugins — a bare
      // data dir (e.g. a plugin's leftover data/) is NOT offered as a plugin.
      const dirs = await listSubdirs(publicPluginDir);
      const present: string[] = [];
      for (const name of dirs) {
        if (await hasPluginEntry(join(publicPluginDir, name))) present.push(name);
      }
      return present;
    },

    readLLMConfig,

    async writeLLMConfig(cfg: LLMConfig): Promise<void> {
      await writeJson(llmPath, cfg);
    },

    async listCommunicators(): Promise<string[]> {
      const cfg = await readLLMConfig();
      return Object.keys(cfg.communicators).sort();
    },
  };
}
