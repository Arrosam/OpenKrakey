/**
 * Contract: llm  ·  connects: llm-gateway (impl) ↔ orchestrator, loader, plugins
 *
 * INFRASTRUCTURE, not domain behavior. Two stable, industry-standard things that
 * have no extension room left and so are safely solidified into the core:
 *
 *  1. The provider-agnostic LLM I/O envelope (request/response data SHAPES).
 *  2. The KEY-LESS `Communicator` surface plugins use to actually talk to an LLM.
 *     The concrete request wire-format, the parsing, and the API keys all live in
 *     the `llm-gateway` core module; plugins only ever see this interface — they
 *     never see the request body or any secret.
 *
 * R1 (refined): the core holds no LLM STRATEGY/CONTENT (prompt construction,
 * memory, model-choice logic, agent behavior, tool implementations). It MAY hold
 * stable INFRASTRUCTURE: these shapes plus the communication EXECUTION. API keys
 * are confined to the core and are NEVER handed to plugins.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image: { url?: string; data?: string; mime?: string } };

export interface Message {
  role: Role;
  content: string | ContentPart[];
  /** For role:"tool" — the id of the ToolCall this message answers. */
  toolCallId?: string;
  /** Optional name (e.g. the tool name for a tool-result message). */
  name?: string;
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

export interface LLMRequest {
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMResponse {
  /** Assistant text content (concatenated text parts). */
  content: string;
  /** Tool calls the model requested (already parsed by the communicator). */
  toolCalls?: ToolCall[];
  stopReason?: "stop" | "length" | "tool_use" | "content_filter" | string;
  usage?: Usage;
  /** Provider-native payload — escape hatch for plugins that need provider specifics. */
  raw?: unknown;
}

// ---- Embeddings (optional capability) ----
export interface EmbedRequest {
  input: string | string[];
  model?: string;
}
export interface EmbedResponse {
  embeddings: number[][];
  usage?: Usage;
}

/**
 * A configured, ready-to-use connection to one LLM (provider + model). KEY-LESS:
 * the API key and the request wire-format live inside the gateway closure and are
 * never exposed here. A plugin picks a communicator by name from the library and
 * calls it; it cannot see credentials or the raw request. This is also how a
 * plugin flexibly switches between LLMs — by choosing a different name.
 */
export interface Communicator {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  chat(req: LLMRequest): Promise<LLMResponse>;
  embed?(req: EmbedRequest): Promise<EmbedResponse>;
}

/** The global catalogue of communicators handed to plugins (no secrets inside). */
export interface CommunicatorLibrary {
  get(name: string): Communicator | undefined;
  has(name: string): boolean;
  list(): string[];
}
