/**
 * OpenAI-compatible chat/completions adapter.
 *
 * Maps the provider-agnostic `LLMRequest` onto the OpenAI `/chat/completions`
 * wire body, POSTs via the global `fetch`, and normalizes the response back into
 * an `LLMResponse`. Works with any OpenAI-compatible endpoint via `cfg.baseURL`.
 * No SDK; the API key arrives in `cfg` and is never logged.
 */
import type {
  LLMRequest,
  LLMResponse,
  EmbedRequest,
  EmbedResponse,
  Message,
  ContentPart,
  ToolDef,
  ToolCall,
  Usage,
} from "../../../../contracts/llm";
import type { AdapterCfg } from "./types";

/** The subtype of a MIME (e.g. "audio/mpeg" → "mpeg"). */
function mimeSubtype(mime: string | undefined): string | undefined {
  if (mime === undefined) return undefined;
  const slash = mime.indexOf("/");
  return slash >= 0 ? mime.slice(slash + 1) : mime;
}

/** Map an audio MIME subtype onto OpenAI's input_audio format enum. */
function audioFormat(mime: string | undefined): "mp3" | "wav" {
  switch (mimeSubtype(mime)) {
    case "mpeg":
    case "mp3":
      return "mp3";
    case "wav":
    case "wave":
    case "x-wav":
      return "wav";
    default:
      return "mp3";
  }
}

/** Map one ContentPart onto an OpenAI content part. */
function mapContentPart(part: ContentPart): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image": {
      const img = part.image;
      if (!img.url && !img.data) {
        return { type: "text", text: "[unsupported image content]" };
      }
      const url =
        img.url ?? `data:${img.mime ?? "image/png"};base64,${img.data}`;
      return { type: "image_url", image_url: { url } };
    }
    case "audio": {
      const audio = part.audio;
      // OpenAI chat has no URL audio form — url-only audio degrades to text.
      if (!audio.data) {
        return { type: "text", text: "[unsupported audio content]" };
      }
      return {
        type: "input_audio",
        input_audio: { data: audio.data, format: audioFormat(audio.mime) },
      };
    }
    case "document": {
      const doc = part.document;
      if (doc.url) {
        return { type: "image_url", image_url: { url: doc.url } };
      }
      if (doc.data) {
        return {
          type: "file",
          file: {
            filename: "document",
            file_data: `data:${doc.mime ?? "application/pdf"};base64,${doc.data}`,
          },
        };
      }
      return { type: "text", text: "[unsupported document content]" };
    }
    case "video":
      return { type: "text", text: "[unsupported video content]" };
  }
}

/** Map message content (string | ContentPart[]) onto OpenAI content. */
function mapContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  // Defensive: a malformed message (missing / non-array content) must not crash the
  // whole request — treat it as empty rather than throwing.
  return Array.isArray(content) ? content.map(mapContentPart) : "";
}

/** Map our messages onto OpenAI messages. */
function mapMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.toolCallId,
        content: mapContent(m.content),
      };
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: mapContent(m.content),
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    const mapped: Record<string, unknown> = {
      role: m.role,
      content: mapContent(m.content),
    };
    // Forward the optional participant name (e.g. a user turn's source channel).
    if (m.name !== undefined) mapped.name = m.name;
    return mapped;
  });
}

/** Map our tool defs onto OpenAI function tool defs. */
function mapTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object" },
    },
  }));
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Map an OpenAI chat finish_reason onto the normalized stopReason vocabulary. */
function normalizeFinishReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "content_filter";
    default:
      return reason;
  }
}

export async function chat(
  req: LLMRequest,
  cfg: AdapterCfg,
): Promise<LLMResponse> {
  const url = `${cfg.baseURL ?? "https://api.openai.com/v1"}/chat/completions`;

  const messages = mapMessages(req.messages);
  if (req.system !== undefined) {
    messages.unshift({ role: "system", content: req.system });
  }

  const body: Record<string, unknown> = {
    model: req.model ?? cfg.model,
    messages,
  };
  if (req.tools !== undefined) body.tools = mapTools(req.tools);
  const temperature = req.temperature ?? cfg.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  const maxTokens = req.maxTokens ?? cfg.maxTokens;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  const topP = req.topP ?? cfg.topP;
  if (topP !== undefined) body.top_p = topP;
  const stop = req.stop ?? cfg.stop;
  if (stop !== undefined) body.stop = stop;
  const reasoningEffort = req.reasoningEffort ?? cfg.reasoningEffort;
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI request failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as OpenAIResponse;

  const choice = data.choices?.[0];
  const message = choice?.message;
  const content = message?.content ?? "";

  const rawToolCalls = message?.tool_calls ?? [];
  const toolCalls: ToolCall[] = rawToolCalls.map((tc) => {
    const rawArgs = tc.function?.arguments ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      parsed = rawArgs;
    }
    return {
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      arguments: parsed,
    };
  });

  const response: LLMResponse = {
    content,
    stopReason: normalizeFinishReason(choice?.finish_reason),
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    },
    raw: data,
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;

  return response;
}

/** Map one ContentPart onto a Responses API input content part. */
function mapResponsesContentPart(part: ContentPart, textType: string): unknown {
  switch (part.type) {
    case "text":
      return { type: textType, text: part.text };
    case "image": {
      const img = part.image;
      const url =
        img.url ??
        `data:${img.mime ?? "image/png"};base64,${img.data ?? ""}`;
      return { type: "input_image", image_url: url };
    }
    case "document": {
      const doc = part.document;
      if (doc.url) {
        return { type: "input_file", file_url: doc.url };
      }
      const dataURI = `data:${doc.mime ?? "application/pdf"};base64,${doc.data ?? ""}`;
      return { type: "input_file", filename: "document", file_data: dataURI };
    }
    case "audio":
    case "video":
      return { type: textType, text: `[unsupported ${part.type} content]` };
  }
}

/** Map message content (string | ContentPart[]) onto Responses input content. */
function mapResponsesContent(
  content: string | ContentPart[],
  role: string,
): unknown[] {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }
  return content.map((part) => mapResponsesContentPart(part, textType));
}

/** True when a message carries any content to send (non-empty string or parts). */
function hasContent(content: string | ContentPart[]): boolean {
  return typeof content === "string" ? content.length > 0 : content.length > 0;
}

/** Map our messages onto Responses API input items. */
function mapResponsesInput(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const output =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      out.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output,
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      if (hasContent(m.content)) {
        out.push({
          type: "message",
          role: m.role,
          content: mapResponsesContent(m.content, m.role),
        });
      }
      for (const tc of m.toolCalls) {
        out.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        });
      }
      continue;
    }
    out.push({
      type: "message",
      role: m.role,
      content: mapResponsesContent(m.content, m.role),
    });
  }
  return out;
}

/** Map our tool defs onto Responses API (flat) function tool defs. */
function mapResponsesTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? { type: "object" },
  }));
}

interface ResponsesMessageItem {
  type: "message";
  content?: Array<{ type?: string; text?: string }>;
}

interface ResponsesFunctionCallItem {
  type: "function_call";
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: string;
}

type ResponsesOutputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | { type?: string };

interface OpenAIResponsesResponse {
  output?: ResponsesOutputItem[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
  status?: string;
  incomplete_details?: { reason?: string };
}

/** Derive the normalized stopReason from a Responses payload. */
function responsesStopReason(
  data: OpenAIResponsesResponse,
): string | undefined {
  if ((data.output ?? []).some((item) => item.type === "function_call")) {
    return "tool_use";
  }
  if (data.status === "incomplete") {
    const reason = data.incomplete_details?.reason;
    switch (reason) {
      case "max_output_tokens":
        return "length";
      case "content_filter":
        return "content_filter";
      default:
        return reason;
    }
  }
  if (data.status === "completed") return "stop";
  return data.status;
}

export async function responsesChat(
  req: LLMRequest,
  cfg: AdapterCfg,
): Promise<LLMResponse> {
  const url = `${cfg.baseURL ?? "https://api.openai.com/v1"}/responses`;

  const body: Record<string, unknown> = {
    model: req.model ?? cfg.model,
    input: mapResponsesInput(req.messages),
  };
  if (req.system !== undefined) body.instructions = req.system;
  if (req.tools !== undefined) body.tools = mapResponsesTools(req.tools);
  const temperature = req.temperature ?? cfg.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  const maxTokens = req.maxTokens ?? cfg.maxTokens;
  if (maxTokens !== undefined) body.max_output_tokens = maxTokens;
  const topP = req.topP ?? cfg.topP;
  if (topP !== undefined) body.top_p = topP;
  const reasoningEffort = req.reasoningEffort ?? cfg.reasoningEffort;
  // The Responses API nests effort under `reasoning: { effort }` (unlike chat
  // completions, which takes a flat `reasoning_effort`).
  if (reasoningEffort !== undefined) body.reasoning = { effort: reasoningEffort };
  // `stop` is deliberately omitted: the Responses API has no stop-sequence param.

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI Responses request failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as OpenAIResponsesResponse;

  let content: string;
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    content = data.output_text;
  } else {
    const parts: string[] = [];
    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const c of (item as ResponsesMessageItem).content ?? []) {
          if (c.type === "output_text" && typeof c.text === "string") {
            parts.push(c.text);
          }
        }
      }
    }
    content = parts.join("");
  }

  const toolCalls: ToolCall[] = [];
  for (const item of data.output ?? []) {
    if (item.type === "function_call") {
      const fc = item as ResponsesFunctionCallItem;
      const rawArgs = fc.arguments ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawArgs);
      } catch {
        parsed = rawArgs;
      }
      toolCalls.push({
        id: fc.call_id ?? fc.id ?? "",
        name: fc.name ?? "",
        arguments: parsed,
      });
    }
  }

  const response: LLMResponse = {
    content,
    stopReason: responsesStopReason(data),
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    },
    raw: data,
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;

  return response;
}

interface OpenAIEmbedResponse {
  data?: Array<{ embedding: number[]; index?: number }>;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export async function embed(
  req: EmbedRequest,
  cfg: AdapterCfg,
): Promise<EmbedResponse> {
  const url = `${cfg.baseURL ?? "https://api.openai.com/v1"}/embeddings`;

  const body: Record<string, unknown> = {
    model: req.model ?? cfg.model,
    input: req.input,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `OpenAI embeddings request failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as OpenAIEmbedResponse;

  const rows = [...(data.data ?? [])];
  // Preserve input order when the provider returns an `index` field.
  if (rows.every((d) => typeof d.index === "number")) {
    rows.sort((a, b) => (a.index as number) - (b.index as number));
  }
  const embeddings = rows.map((d) => d.embedding);

  const response: EmbedResponse = { embeddings };
  if (data.usage !== undefined) {
    response.usage = { inputTokens: data.usage.prompt_tokens } as Usage;
  }
  return response;
}
