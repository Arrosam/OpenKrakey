/**
 * Cohere / Jina-compatible `/rerank` adapter.
 *
 * Maps the provider-agnostic `RerankRequest` onto the Cohere/Jina rerank wire body
 * (`{ model, query, documents, top_n? }`), POSTs via the global `fetch`, and
 * normalizes the response. The base URL is provider-defaulted by the gateway
 * (cohere `https://api.cohere.com/v2`, jina `https://api.jina.ai/v1`). No SDK; the
 * API key arrives in `cfg` and is never logged.
 */
import type {
  RerankRequest,
  RerankResponse,
  RerankResult,
  Usage,
} from "../../../../contracts/llm";
import type { AdapterCfg } from "./types";

interface RerankApiResult {
  index: number;
  relevance_score: number;
  document?: unknown;
}

interface RerankApiResponse {
  results?: RerankApiResult[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** A provider's echoed document is a string, or an object with a string `.text`. */
function echoedDocument(doc: unknown): string | undefined {
  if (typeof doc === "string") return doc;
  if (
    doc !== null &&
    typeof doc === "object" &&
    typeof (doc as { text?: unknown }).text === "string"
  ) {
    return (doc as { text: string }).text;
  }
  return undefined;
}

export async function rerank(
  req: RerankRequest,
  cfg: AdapterCfg,
): Promise<RerankResponse> {
  const url = `${cfg.baseURL}/rerank`;

  const body: Record<string, unknown> = {
    model: req.model ?? cfg.model,
    query: req.query,
    documents: req.documents,
    ...(req.topN !== undefined ? { top_n: req.topN } : {}),
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
      `Rerank request failed: ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as RerankApiResponse;

  let results: RerankResult[] = (data.results ?? [])
    .map((r) => ({
      index: r.index,
      score: r.relevance_score,
      document: echoedDocument(r.document) ?? req.documents[r.index],
    }))
    .sort((a, b) => b.score - a.score);

  if (req.topN !== undefined) {
    results = results.slice(0, req.topN);
  }

  const response: RerankResponse = { results };
  if (data.usage !== undefined) {
    const usage: Usage = {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
    };
    response.usage = usage;
  }
  return response;
}
