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

/** Map one ContentPart onto an OpenAI content part. */
function mapContentPart(part: ContentPart): unknown {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  // image
  const img = part.image;
  const url =
    img.url ??
    (img.data ? `data:${img.mime ?? "image/png"};base64,${img.data}` : "");
  return { type: "image_url", image_url: { url } };
}

/** Map message content (string | ContentPart[]) onto OpenAI content. */
function mapContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map(mapContentPart);
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
    return { role: m.role, content: mapContent(m.content) };
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
  if (req.stop !== undefined) body.stop = req.stop;

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
    stopReason: choice?.finish_reason,
    usage: {
      inputTokens: data.usage?.prompt_tokens,
      outputTokens: data.usage?.completion_tokens,
    },
    raw: data,
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;

  return response;
}
