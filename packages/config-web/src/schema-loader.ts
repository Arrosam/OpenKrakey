/**
 * config-web/schema-loader — assembles the single JSON schema payload the SPA
 * auto-renders from. It is the web equivalent of the cli's provider/plugin
 * knowledge: rather than hardcoding every setting in the page, the page fetches
 * this and builds its controls generically.
 *
 * Plugin schemas are discovered, not listed: every plugin's "config-schema.ts"
 * under public_plugin/ is a PURE-DATA module (it imports only the `ConfigField` type — never the
 * plugin's runtime index.ts), so we can dynamic-import it to read its exported
 * `ConfigField[]` without executing any plugin code. The provider catalogue and
 * the capability/modality labels come straight from shared/config (single source
 * of truth — no copies live here).
 */
import { readdir, access } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

import {
  KNOWN_PROVIDERS,
  CAPABILITY_LABELS,
  MODALITY_LABELS,
} from "../../../shared/config";
import type { ConfigSchema } from "../../../contracts/plugin";

/** Friendly metadata for a known plugin id (icon/name/tagline shown in the UI). */
interface PluginMeta {
  id: string;
  name?: string;
  icon?: string;
  tagline?: string;
  dataCarrier?: boolean;
  required?: boolean;
}

/**
 * Static friendly-name table, ported verbatim from the mock's PLUGINS. Unknown
 * ids (a plugin not listed here) fall back to `{ id, name: id }` so a freshly
 * added plugin still renders — just without a custom icon/tagline.
 */
const PLUGIN_META: Record<string, PluginMeta> = {
  "llm-core": { id: "llm-core", icon: "cpu", name: "LLM core", tagline: "talks to the AI service — the agent's brain (optional)" },
  persona: { id: "persona", icon: "person", name: "Persona", tagline: "the agent's identity / system prompt" },
  "system-prompt": { id: "system-prompt", icon: "terminal", name: "System prompt", tagline: "operating model: monologue rule + tool use" },
  "web-chat": { id: "web-chat", icon: "chat", name: "Web chat", tagline: "chat with the agent from your browser", dataCarrier: true },
  krakeycode: { id: "krakeycode", icon: "code", name: "Coding tools", tagline: "read / write files, run shell, list dirs" },
  searxng: { id: "searxng", icon: "search", name: "Web search", tagline: "search the web via a SearXNG instance" },
  browser: { id: "browser", icon: "globe", name: "Browser", tagline: "read-only Chrome control — navigate + screenshot" },
  inspector: { id: "inspector", icon: "activity", name: "Inspector", tagline: "live debug panel for every beat", dataCarrier: true },
  "memory-note": {
    id: "memory-note",
    icon: "journal",
    name: "Notes",
    tagline: "the agent's private long-term notebook",
    dataCarrier: true,
  },
  history: { id: "history", icon: "clock", name: "History", tagline: "a compacted log of the agent's tool use", dataCarrier: true },
};

export interface SchemaPayload {
  providers: unknown[];
  capabilityLabels: Record<string, string>;
  modalityLabels: Record<string, string>;
  plugins: Array<{
    id: string;
    name?: string;
    icon?: string;
    tagline?: string;
    dataCarrier?: boolean;
    required?: boolean;
  }>;
  pluginSchemas: Record<string, ConfigSchema>;
  agentFields: ConfigSchema;
}

/** List immediate subdirectory names of `dir`, sorted. Missing dir → []. */
async function listPluginDirs(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/**
 * Dynamic-import a plugin's pure-data config-schema module and return its
 * exported `ConfigField[]`. A schema module names its export freely (e.g.
 * `LLM_CORE_SCHEMA`), so we pick the first exported array. Returns undefined when
 * the module is absent or exports no array (the plugin has no config-schema.ts).
 */
async function loadPluginSchema(schemaPath: string): Promise<ConfigSchema | undefined> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(schemaPath).href)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const arr = Object.values(mod).find((v) => Array.isArray(v));
  return arr as ConfigSchema | undefined;
}

/**
 * Walk `publicPluginDir`, collect each plugin id and (if present) its config
 * schema, and bundle them with the provider catalogue + the core agent fields
 * into the single payload the SPA renders from.
 */
export async function assembleSchema(deps: {
  publicPluginDir: string;
}): Promise<SchemaPayload> {
  const allDirs = await listPluginDirs(deps.publicPluginDir);
  const ids: string[] = [];
  for (const name of allDirs) {
    for (const entry of ["index.ts", "index.js"]) {
      try { await access(join(deps.publicPluginDir, name, entry)); ids.push(name); break; } catch { /* absent */ }
    }
  }

  const pluginSchemas: Record<string, ConfigSchema> = {};
  const plugins: SchemaPayload["plugins"] = [];
  for (const id of ids) {
    const schema = await loadPluginSchema(join(deps.publicPluginDir, id, "config-schema.ts"));
    if (schema) pluginSchemas[id] = schema;
    plugins.push(PLUGIN_META[id] ?? { id, name: id });
  }

  const pluginOptions = ids.map((id) => ({
    value: id,
    label: PLUGIN_META[id]?.name ?? id,
  }));

  const agentFields: ConfigSchema = [
    {
      key: "intervalMs",
      label: "Heartbeat interval",
      type: "number",
      default: 30000,
      min: 1,
      step: 1000,
      unit: "ms",
      help: "How often the agent wakes to think unprompted, in milliseconds (60000 = 1 minute).",
    },
    {
      key: "plugins",
      label: "Plugins to load",
      type: "multienum",
      default: [],
      options: pluginOptions,
      help: "Everything this agent can do. Each is a public_plugin/.",
    },
    {
      key: "privatePlugins",
      label: "Private data copies",
      type: "multienum",
      default: [],
      options: pluginOptions,
      help: "These plugins get their own isolated data under this agent instead of sharing the public copy.",
    },
  ];

  return {
    providers: [...KNOWN_PROVIDERS],
    capabilityLabels: CAPABILITY_LABELS,
    modalityLabels: MODALITY_LABELS,
    plugins,
    pluginSchemas,
    agentFields,
  };
}
