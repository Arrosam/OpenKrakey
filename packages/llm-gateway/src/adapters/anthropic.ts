/**
 * Anthropic Messages API adapter.
 *
 * Maps the provider-agnostic `LLMRequest` onto the Anthropic `/v1/messages` wire
 * body, POSTs via the global `fetch`, and normalizes the response back into an
 * `LLMResponse`. No SDK; the API key arrives in `cfg` and is never logged.
 */
import type {
  LLMRequest,
  LLMResponse,
  Message,
  ContentPart,
  ToolDef,
  ToolCall,
} from "../../../../contracts/llm";

export interface AdapterCfg {
  apiKey: string;
  model: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Map one ContentPart onto an Anthropic content block. */
function mapContentPart(part: ContentPart): unknown {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  // image
  const img = part.image;
  if (img.url) {
    return { type: "image", source: { type: "url", url: img.url } };
  }
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: img.mime ?? "image/png",
      data: img.data,
    },
  };
}

/** Map message content (string | ContentPart[]) onto Anthropic content. */
function mapContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map(mapContentPart);
}

/** Map our messages onto Anthropic messages (role user/assistant only). */
function mapMessages(messages: Message[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: mapContent(m.content),
          },
        ],
      };
    }
    return { role: m.role, content: mapContent(m.content) };
  });
}

/** Map our tool defs onto Anthropic tool defs. */
function mapTools(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object" },
  }));
}

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function chat(
  req: LLMRequest,
  cfg: AdapterCfg,
): Promise<LLMResponse> {
  const url = `${cfg.baseURL ?? "https://api.anthropic.com"}/v1/messages`;

  const body: Record<string, unknown> = {
    model: req.model ?? cfg.model,
    max_tokens: req.maxTokens ?? cfg.maxTokens ?? 4096,
    messages: mapMessages(req.messages),
  };
  if (req.system !== undefined) body.system = req.system;
  if (req.tools !== undefined) body.tools = mapTools(req.tools);
  const temperature = req.temperature ?? cfg.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  if (req.stop !== undefined) body.stop_sequences = req.stop;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Anthropic request failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as AnthropicResponse;

  const blocks = data.content ?? [];
  const content = blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");

  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: b.id ?? "",
      name: b.name ?? "",
      arguments: b.input,
    }));

  const response: LLMResponse = {
    content,
    stopReason: data.stop_reason,
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    },
    raw: data,
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;

  return response;
}
