# Node: llm-gateway

## Purpose
The global **LLM communication gateway**. Turns the LLM config (`config/llm.json`, which holds API
keys) into a **key-less `CommunicatorLibrary`**. Each `Communicator` internally builds the provider
request, sends it (native `fetch`), and parses the response (incl. tool calls) into the normalized
`LLMResponse`. API keys are held inside the gateway closure and are **never exposed** — plugins only
ever get the key-less library. This solidifies the industry-standard, no-extension-room LLM request +
parse machinery into core (R1: infrastructure, not strategy).

## Zone
core

## Implements contracts
- `llm` — `Communicator`, `CommunicatorLibrary` (the envelope types are shared shapes it consumes).

## Depends on contracts
- `llm` — the I/O envelope (`LLMRequest`/`LLMResponse`/…).
- (Uses shared `config` for `LLMConfig`/`CommunicatorDef`.)

## Exposed interface
- `createCommunicatorLibrary(config: LLMConfig, opts?): CommunicatorLibrary` (pure: config → library;
  the file is read by boot, not here — keeps the gateway testable without fs/network).
- Provider adapters: `anthropic` (Messages API) + `openai` (openai-compatible chat/completions),
  selected per `CommunicatorDef.provider`. Extensible by adding an adapter.

## Internal structure
For each `CommunicatorDef`: resolve `apiKey` (literal or `${ENV_VAR}`), pick the adapter, and build a
`Communicator` whose `chat()` maps `LLMRequest` → provider wire body → `fetch` (with auth header) →
provider response → normalized `LLMResponse` (content, `toolCalls` parsed, `usage`, `stopReason`,
`raw`). The key is captured in the closure; the returned object exposes only `name/provider/model` +
`chat`/`embed?`. Unknown provider → throw; missing key → throw at build time. `list()/get()/has()` over
the built map.

## Status
pending

## Change log
- 2026-06-07: node created (LLM gateway — global, key-isolated, multi-provider).
