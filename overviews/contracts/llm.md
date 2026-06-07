# Contract: llm

## Purpose
INFRASTRUCTURE (not domain behavior). Fixes two stable, industry-standard things with no extension
room left, so they are safely solidified into core: (1) the provider-agnostic LLM I/O **envelope**
(request/response data shapes), and (2) the **key-less Communicator surface** plugins use to talk to
an LLM. The actual request wire-format, parsing, and API keys live in the `llm-gateway` module — never
in this interface.

## Connects
llm-gateway (implements Communicator/CommunicatorLibrary) ↔ orchestrator (uses `LLMResponse`), loader
(injects the library into `PluginContext.llm`), agent_instance + boot (pass the global library through),
and plugins (consume communicators by name).

## Interface definition
- **Envelope**: `Role`, `ContentPart` (text | image), `Message {role, content, toolCallId?, name?}`,
  `ToolDef {name, description?, parameters?}`, `ToolCall {id, name, arguments}`,
  `LLMRequest {messages, system?, tools?, model?, temperature?, maxTokens?, stop?, stream?, metadata?}`,
  `Usage {inputTokens?, outputTokens?}`,
  `LLMResponse {content, toolCalls?, stopReason?, usage?, raw?}`, plus `EmbedRequest`/`EmbedResponse`.
- **Communicator** `{ readonly name, provider, model; chat(req): Promise<LLMResponse>; embed?(req) }`
  — KEY-LESS; exposes no credentials or wire-format.
- **CommunicatorLibrary** `{ get(name)→Communicator|undefined; has(name); list() }`.

## Behavioral constraints
- `ToolCall.arguments` is already JSON-parsed by the communicator; `LLMResponse.content` is the
  concatenated assistant text; `toolCalls` is the parsed tool-use list (empty/absent if none).
- A Communicator NEVER exposes its API key or request body. Switching LLM = choosing another name.
- The library is read-only to consumers (no registration surface here — the gateway builds it).

## Status
locked
