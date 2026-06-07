/**
 * llm-gateway — turns the (key-bearing) LLMConfig into a key-LESS
 * CommunicatorLibrary.
 *
 * PURE: config in, library out. No filesystem access (boot reads config/llm.json
 * and hands us the parsed object). For each configured communicator we resolve
 * its API key, pick a provider adapter, and capture the key inside a closure so
 * it is NEVER exposed as a property on the returned Communicator — plugins get a
 * name, provider, model, and a `chat` method, and no secrets.
 */
import type { LLMConfig, CommunicatorDef } from "../../../shared/config";
import type {
  Communicator,
  CommunicatorLibrary,
} from "../../../contracts/llm";
import * as anthropic from "./adapters/anthropic";
import * as openai from "./adapters/openai";

/**
 * Resolve an apiKey field: `"${ENV_VAR}"` → `process.env.ENV_VAR`, otherwise the
 * literal value as-is. Returns undefined when unset.
 */
function resolveKey(apiKey: string | undefined): string | undefined {
  if (apiKey === undefined) return undefined;
  const match = /^\$\{(.+)\}$/.exec(apiKey);
  if (match) return process.env[match[1]];
  return apiKey;
}

type Adapter = typeof anthropic;

/** Pick the provider adapter, throwing on an unknown provider. */
function pickAdapter(provider: string): Adapter {
  switch (provider) {
    case "anthropic":
      return anthropic;
    case "openai":
      return openai;
    default:
      throw new Error("Unknown LLM provider: " + provider);
  }
}

/** Build one key-less Communicator from a configured definition. */
function buildCommunicator(name: string, def: CommunicatorDef): Communicator {
  const adapter = pickAdapter(def.provider);
  const apiKey = resolveKey(def.apiKey);
  if (apiKey === undefined || apiKey === "") {
    throw new Error("Missing API key for communicator: " + name);
  }

  // apiKey is captured here and never assigned onto the returned object.
  return {
    name,
    provider: def.provider,
    model: def.model,
    chat: (req) =>
      adapter.chat(req, {
        apiKey,
        model: def.model,
        baseURL: def.baseURL,
        temperature: def.temperature,
        maxTokens: def.maxTokens,
      }),
  };
}

/**
 * Build the global, key-less CommunicatorLibrary from the LLM config.
 */
export function createCommunicatorLibrary(
  config: LLMConfig,
): CommunicatorLibrary {
  const map = new Map<string, Communicator>();

  for (const [name, def] of Object.entries(config.communicators)) {
    map.set(name, buildCommunicator(name, def));
  }

  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    list: () => [...map.keys()],
  };
}
