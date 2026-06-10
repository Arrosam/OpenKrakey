# Contract: llm

## Purpose
INFRASTRUCTURE (not domain behavior). Fixes the stable, industry-standard shapes that are safely
solidified into core: (1) the provider-agnostic, **multimodal** LLM I/O envelope (chat + embed +
rerank + ocr, plus the modality vocabulary), and (2) the **key-less Communicator surface** plugins use.
A communicator declares its `capabilities` + input/output `Modality`s and exposes only the methods it
was configured for. Keys + wire-format live in the `llm-gateway` module — never in this interface.

## Connects
llm-gateway (implements) ↔ orchestrator (uses `LLMResponse`), loader (injects the library into
`PluginContext.llm`), agent_instance + boot (pass the global library through), and plugins (consume).

## Interface definition
- **Vocabulary**: `Modality` = text | image | audio | video | document; `Capability` = chat | embed |
  rerank | ocr; `MediaRef` = `{ url?, data?(base64), mime? }`.
- **Multimodal content**: `ContentPart` = text | image | audio | video | document (each carries a
  `MediaRef` except text). `Message {role, content: string|ContentPart[], toolCallId?, name?}`.
- **chat**: `LLMRequest {messages, system?, tools?, model?, temperature?, maxTokens?, stop?, stream?,
  metadata?}` → `LLMResponse {content, toolCalls?, stopReason?, usage?, raw?}`.
- **embed**: `EmbedRequest {input, model?}` → `EmbedResponse {embeddings: number[][], usage?}`.
- **rerank**: `RerankRequest {query, documents, topN?, model?}` → `RerankResponse {results:
  [{index, score, document?}] (desc), usage?}`.
- **ocr**: `OCRRequest {source: MediaRef, model?}` → `OCRResponse {text, raw?}`.
- **Communicator** `{ readonly name, provider, model, capabilities, input, output; chat?/embed?/rerank?/ocr? }`
  — KEY-LESS; only the methods for declared capabilities are present.
- **CommunicatorLibrary** `{ get, has, list, withCapability(cap)→names }`.

## Behavioral constraints
- `capabilities`/`input`/`output` are METADATA (plugins pick a suitable model); a method is present iff
  its capability is declared AND the provider supports it. Defaults: capabilities `["chat"]`, input/
  output `["text"]`.
- A Communicator NEVER exposes its API key. `ToolCall.arguments` is pre-parsed; `RerankResponse.results`
  are sorted by descending score.

## Status
locked

## Change log
- 2026-06-11: additive — Message.toolCalls (assistant turns replay their tool calls; adapters map to tool_use / tool_calls / function_call); stopReason documented as NORMALIZED to the named union (provider-native in raw); stream/metadata documented as RESERVED no-ops.
