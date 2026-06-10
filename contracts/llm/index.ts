/**
 * Contract: llm  ·  connects: llm-gateway (impl) ↔ orchestrator, loader, plugins
 *
 * INFRASTRUCTURE, not domain behavior. Stable, industry-standard shapes that are
 * safely solidified into the core:
 *
 *  1. The provider-agnostic, MULTIMODAL LLM I/O envelope (chat + embed + rerank +
 *     ocr request/response shapes, and the modality vocabulary).
 *  2. The KEY-LESS `Communicator` surface plugins use. A communicator declares its
 *     `capabilities` and input/output `Modality`s (so plugins can pick a suitable
 *     model) and exposes ONLY the methods for the capabilities it was configured
 *     for. The request wire-format, parsing, and API keys live in the `llm-gateway`
 *     module; plugins never see a key.
 *
 * R1 (refined): the core holds no LLM STRATEGY/CONTENT (prompt construction,
 * memory, model-choice logic, tools). It MAY hold these stable shapes plus the
 * communication EXECUTION. API keys are confined to the core, never given to plugins.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** Input/output content modalities a model may support. */
export type Modality = "text" | "image" | "audio" | "video" | "document";

/** Operations a communicator may expose. */
export type Capability = "chat" | "embed" | "rerank" | "ocr";

/** A media payload reference: a `url`, or inline base64 `data` (+ `mime`). */
export interface MediaRef {
  url?: string;
  /** base64-encoded bytes (when not a url). */
  data?: string;
  /** MIME type, e.g. "image/png", "audio/mpeg", "application/pdf". */
  mime?: string;
}

/** One piece of multimodal message content. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: MediaRef }
  | { type: "audio"; audio: MediaRef }
  | { type: "video"; video: MediaRef }
  | { type: "document"; document: MediaRef };

export interface Message {
  role: Role;
  content: string | ContentPart[];
  /** For role:"tool" — the id of the ToolCall this message answers. */
  toolCallId?: string;
  /** Optional name (e.g. the tool name for a tool-result message). */
  name?: string;
  /**
   * For role:"assistant" — the tool calls this assistant turn emitted. Required to
   * replay multi-turn tool conversations: a later role:"tool" message references a
   * ToolCall id, and providers reject a tool result whose call was never re-sent.
   * Adapters map these onto the provider's native form (Anthropic `tool_use`
   * blocks, OpenAI `tool_calls`, Responses `function_call` items).
   */
  toolCalls?: ToolCall[];
}

export interface ToolDef {
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters. */
  parameters?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments, already JSON-parsed by the communicator. */
  arguments: unknown;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

// ---- chat ----
export interface LLMRequest {
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  /** RESERVED — streaming is not yet implemented; adapters currently ignore this. */
  stream?: boolean;
  /** RESERVED — not yet forwarded to providers; adapters currently ignore this. */
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  /** Assistant text content (concatenated text parts). */
  content: string;
  /** Tool calls the model requested (already parsed). */
  toolCalls?: ToolCall[];
  /**
   * NORMALIZED stop reason: adapters map each provider's native value onto the
   * named members ("stop" | "length" | "tool_use" | "content_filter"); an
   * unrecognized native value passes through as-is. The provider-native value is
   * always available via `raw`.
   */
  stopReason?: "stop" | "length" | "tool_use" | "content_filter" | string;
  usage?: Usage;
  /** Provider-native payload — escape hatch for plugins that need specifics. */
  raw?: unknown;
}

// ---- embed ----
export interface EmbedRequest {
  input: string | string[];
  model?: string;
}
export interface EmbedResponse {
  /** One vector per input (input order preserved). */
  embeddings: number[][];
  usage?: Usage;
}

// ---- rerank ----
export interface RerankRequest {
  query: string;
  documents: string[];
  /** Return only the top-N results (provider may default). */
  topN?: number;
  model?: string;
}
export interface RerankResult {
  /** Index into the original `documents` array. */
  index: number;
  /** Relevance score (higher = more relevant). */
  score: number;
  /** The document text, if the provider echoes it. */
  document?: string;
}
export interface RerankResponse {
  /** Sorted by descending score. */
  results: RerankResult[];
  usage?: Usage;
}

// ---- ocr ----
export interface OCRRequest {
  /** The image or document to extract text from. */
  source: MediaRef;
  model?: string;
}
export interface OCRResponse {
  text: string;
  raw?: unknown;
}

/**
 * A configured, ready-to-use connection to one model. KEY-LESS: the API key and
 * the request wire-format live inside the gateway and are never exposed here. The
 * communicator declares its `capabilities` and input/output `Modality`s as
 * metadata (so a plugin can choose a suitable model), and exposes ONLY the methods
 * for the capabilities it was configured for (the rest are undefined). Switching
 * model/provider = choosing a different communicator by name.
 */
export interface Communicator {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly capabilities: readonly Capability[];
  readonly input: readonly Modality[];
  readonly output: readonly Modality[];
  chat?(req: LLMRequest): Promise<LLMResponse>;
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
  rerank?(req: RerankRequest): Promise<RerankResponse>;
  ocr?(req: OCRRequest): Promise<OCRResponse>;
}

/** The global catalogue of communicators handed to plugins (no secrets inside). */
export interface CommunicatorLibrary {
  get(name: string): Communicator | undefined;
  has(name: string): boolean;
  list(): string[];
  /** Names of the communicators that declare a given capability. */
  withCapability(cap: Capability): string[];
}
