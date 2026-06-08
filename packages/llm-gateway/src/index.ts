/**
 * llm-gateway — turns the (key-bearing) LLMConfig into a key-LESS,
 * capability-aware CommunicatorLibrary.
 *
 * PURE: config in, library out. No filesystem access (boot reads config/llm.json
 * and hands us the parsed object). For each configured communicator we resolve its
 * API key, pick a provider adapter, and capture the key inside closures so it is
 * NEVER exposed as a property on the returned Communicator — plugins get name,
 * provider, model, capability/modality metadata, and ONLY the methods for the
 * capabilities the communicator was configured for. No secrets, no extra methods.
 *
 * RESILIENCE: a single misconfigured communicator (missing key, unknown provider,
 * unsupported capability) is skipped and reported via `opts.onError`; the rest of
 * the library still loads.
 */
import type { LLMConfig, CommunicatorDef } from "../../../shared/config";
import type {
  Communicator,
  CommunicatorLibrary,
  Capability,
  LLMRequest,
  LLMResponse,
  EmbedRequest,
  EmbedResponse,
  RerankRequest,
  RerankResponse,
  OCRRequest,
  OCRResponse,
} from "../../../contracts/llm";
import type { AdapterCfg } from "./adapters/types";
import * as anthropic from "./adapters/anthropic";
import * as openai from "./adapters/openai";
import * as rerankAdapter from "./adapters/rerank";

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

type ChatFn = (req: LLMRequest, cfg: AdapterCfg) => Promise<LLMResponse>;
type EmbedFn = (req: EmbedRequest, cfg: AdapterCfg) => Promise<EmbedResponse>;
type RerankFn = (req: RerankRequest, cfg: AdapterCfg) => Promise<RerankResponse>;

interface Adapter {
  chat?: ChatFn;
  embed?: EmbedFn;
  rerank?: RerankFn;
  defaultBaseURL?: string;
}

/** Pick the provider adapter, throwing on an unknown provider. */
function pickAdapter(provider: string): Adapter {
  switch (provider) {
    case "anthropic":
      return { chat: anthropic.chat };
    case "openai":
      return { chat: openai.chat, embed: openai.embed };
    case "openai-responses":
      return { chat: openai.responsesChat, embed: openai.embed };
    case "cohere":
      return {
        rerank: rerankAdapter.rerank,
        defaultBaseURL: "https://api.cohere.com/v2",
      };
    case "jina":
      return {
        rerank: rerankAdapter.rerank,
        defaultBaseURL: "https://api.jina.ai/v1",
      };
    default:
      throw new Error("Unknown LLM provider: " + provider);
  }
}

const OCR_PROMPT =
  "Extract all text from this content. Return only the extracted text, verbatim, with no commentary.";

function unsupported(name: string, provider: string, cap: Capability): Error {
  return new Error(
    'Communicator "' +
      name +
      '": provider "' +
      provider +
      '" does not support capability "' +
      cap +
      '"',
  );
}

/** Build one key-less, capability-gated Communicator from a configured definition. */
function buildCommunicator(name: string, def: CommunicatorDef): Communicator {
  const adapter = pickAdapter(def.provider);
  const apiKey = resolveKey(def.apiKey);
  if (apiKey === undefined || apiKey === "") {
    throw new Error("Missing API key for communicator: " + name);
  }

  const capabilities = def.capabilities ?? ["chat"];

  // apiKey is captured here and stays inside the gateway — never assigned onto
  // the returned object.
  const cfg: AdapterCfg = {
    apiKey,
    model: def.model,
    baseURL: def.baseURL ?? adapter.defaultBaseURL,
    temperature: def.temperature,
    maxTokens: def.maxTokens,
  };

  let chat: ((req: LLMRequest) => Promise<LLMResponse>) | undefined;
  let embed: ((req: EmbedRequest) => Promise<EmbedResponse>) | undefined;
  let rerank: ((req: RerankRequest) => Promise<RerankResponse>) | undefined;
  let ocr: ((req: OCRRequest) => Promise<OCRResponse>) | undefined;

  for (const cap of capabilities) {
    switch (cap) {
      case "chat": {
        if (!adapter.chat) throw unsupported(name, def.provider, cap);
        chat = (req) => adapter.chat!(req, cfg);
        break;
      }
      case "embed": {
        if (!adapter.embed) throw unsupported(name, def.provider, cap);
        embed = (req) => adapter.embed!(req, cfg);
        break;
      }
      case "rerank": {
        if (!adapter.rerank) throw unsupported(name, def.provider, cap);
        rerank = (req) => adapter.rerank!(req, cfg);
        break;
      }
      case "ocr": {
        // OCR is generic: run it through a vision-capable chat adapter.
        const chatFn = adapter.chat;
        if (!chatFn) throw unsupported(name, def.provider, cap);
        ocr = async (req) => {
          const resp = await chatFn(
            {
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "image", image: req.source },
                    { type: "text", text: OCR_PROMPT },
                  ],
                },
              ],
              model: req.model,
            },
            cfg,
          );
          return { text: resp.content, raw: resp.raw };
        };
        break;
      }
    }
  }

  return {
    name,
    provider: def.provider,
    model: def.model,
    capabilities,
    input: def.input ?? ["text"],
    output: def.output ?? ["text"],
    ...(chat ? { chat } : {}),
    ...(embed ? { embed } : {}),
    ...(rerank ? { rerank } : {}),
    ...(ocr ? { ocr } : {}),
  };
}

export interface GatewayOptions {
  /** Called when a communicator fails to build (skipped, not fatal). */
  onError?: (name: string, err: unknown) => void;
}

/**
 * Build the global, key-less CommunicatorLibrary from the LLM config. A
 * communicator that fails to build is skipped and reported via `opts.onError`;
 * the remaining communicators still load.
 */
export function createCommunicatorLibrary(
  config: LLMConfig,
  opts: GatewayOptions = {},
): CommunicatorLibrary {
  const map = new Map<string, Communicator>();

  for (const [name, def] of Object.entries(config.communicators)) {
    try {
      map.set(name, buildCommunicator(name, def));
    } catch (err) {
      opts.onError?.(name, err);
    }
  }

  return {
    get: (name) => map.get(name),
    has: (name) => map.has(name),
    list: () => [...map.keys()],
    withCapability: (cap) =>
      [...map.values()]
        .filter((c) => c.capabilities.includes(cap))
        .map((c) => c.name),
  };
}
