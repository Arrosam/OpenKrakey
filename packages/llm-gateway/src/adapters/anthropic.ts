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
import type { AdapterCfg } from "./types";

/** Map one ContentPart onto an Anthropic content block. */
function mapContentPart(part: ContentPart): unknown {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image": {
      const img = part.image;
      if (!img.url && !img.data) {
        return { type: "text", text: "[unsupported image content]" };
      }
      return {
        type: "image",
        source: img.url
          ? { type: "url", url: img.url }
          : {
              type: "base64",
              media_type: img.mime ?? "image/png",
              data: img.data,
            },
      };
    }
    case "document": {
      const doc = part.document;
      if (!doc.url && !doc.data) {
        return { type: "text", text: "[unsupported document content]" };
      }
      return {
        type: "document",
        source: doc.url
          ? { type: "url", url: doc.url }
          : {
              type: "base64",
              media_type: doc.mime ?? "application/pdf",
              data: doc.data,
            },
      };
    }
    case "audio":
    case "video":
      // Anthropic Messages API doesn't accept these — degrade gracefully so the
      // call never crashes.
      return { type: "text", text: "[unsupported " + part.type + " content]" };
  }
}

/** Map message content (string | ContentPart[]) onto Anthropic content. */
function mapContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map(mapContentPart);
}

/** Map an assistant message's text content into Anthropic text blocks. */
function assistantTextBlocks(content: string | ContentPart[]): unknown[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  return content
    .filter((p) => p.type === "text" && p.text.length > 0)
    .map((p) => ({ type: "text", text: (p as { text: string }).text }));
}

/**
 * Map our messages onto Anthropic messages (role user/assistant only). system
 * messages are hoisted out separately (see {@link chat}) and never appear here.
 */
function mapMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: mapContent(m.content),
          },
        ],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const blocks = [
        ...assistantTextBlocks(m.content),
        ...m.toolCalls.map((tc) => ({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        })),
      ];
      out.push({ role: "assistant", content: blocks });
      continue;
    }
    out.push({ role: m.role, content: mapContent(m.content) });
  }
  return out;
}

/** Concatenate the text of any role:"system" messages (in order). */
function hoistSystem(messages: Message[]): string | undefined {
  const texts = messages
    .filter((m) => m.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content
            .filter((p) => p.type === "text")
            .map((p) => (p as { text: string }).text)
            .join(""),
    );
  return texts.length > 0 ? texts.join("\n") : undefined;
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

/** Map an Anthropic stop_reason onto the normalized stopReason vocabulary. */
function normalizeStopReason(reason: string | undefined): string | undefined {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    default:
      return reason;
  }
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
  const hoisted = hoistSystem(req.messages);
  const system =
    req.system !== undefined && hoisted !== undefined
      ? `${req.system}\n${hoisted}`
      : (req.system ?? hoisted);
  if (system !== undefined) body.system = system;
  if (req.tools !== undefined) body.tools = mapTools(req.tools);
  const temperature = req.temperature ?? cfg.temperature;
  if (temperature !== undefined) body.temperature = temperature;
  const topP = req.topP ?? cfg.topP;
  if (topP !== undefined) body.top_p = topP;
  const stop = req.stop ?? cfg.stop;
  if (stop !== undefined) body.stop_sequences = stop;
  // reasoningEffort is deliberately NOT wired for Anthropic: the Messages API has
  // no effort enum — it uses `thinking: { budget_tokens }`, a different mechanism.

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
    stopReason: normalizeStopReason(data.stop_reason),
    usage: {
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    },
    raw: data,
  };
  if (toolCalls.length > 0) response.toolCalls = toolCalls;

  return response;
}
