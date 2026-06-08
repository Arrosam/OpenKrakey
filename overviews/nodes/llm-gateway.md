# Node: llm-gateway

## Purpose
The global **LLM communication gateway**. Turns the LLM config (`config/llm.json`, which holds API
keys) into a **key-less, capability-aware `CommunicatorLibrary`**. Each `Communicator` exposes only
the methods (chat/embed/rerank/ocr) it was configured for, carries input/output modality metadata, and
internally builds the provider request, sends it (native `fetch`), and normalizes the response. API
keys stay in closures — never exposed. Industry-standard, no-extension-room machinery solidified into
core (R1: infrastructure, not strategy).

## Zone
core

## Implements contracts
- `llm` — `Communicator`, `CommunicatorLibrary` (the envelope types are shared shapes it consumes).

## Depends on contracts
- `llm` — the I/O envelope + capability/modality vocabulary.
- (Uses shared `config` for `LLMConfig`/`CommunicatorDef`.)

## Exposed interface
- `createCommunicatorLibrary(config: LLMConfig, opts?: { onError?(name, err) }): CommunicatorLibrary`
  (pure: config → library; the file is read by boot). **Resilient**: a communicator that fails to build
  (unknown provider / missing key / unsupported capability) is SKIPPED and reported via `opts.onError`,
  so one bad config never sinks the whole library. Library: `get/has/list/withCapability(cap)`.

## Internal structure
`buildCommunicator` resolves the key (`${ENV_VAR}` or literal) into a closure-captured `cfg`, picks the
provider adapter, and wires ONLY the declared+supported capability methods (conditional spread → others
absent). Provider → capability matrix: `anthropic`→chat · `openai`→chat + embed(`/embeddings`) ·
`cohere`/`jina`→rerank (Cohere/Jina-compatible `/rerank`, default base URLs). **OCR is generic**: any
chat-capable (vision) provider does it — `ocr()` routes a `{image + "extract text"}` chat call and
returns the text. Adapters (`adapters/{types,anthropic,openai,rerank}.ts`) map the 5 `ContentPart`
types (image/document via url|base64; audio→provider form; video→best-effort text placeholder) and
normalize responses. `apiKey`/`cfg` stay inside the gateway, never on the returned object.

## Status
done

## Change log
- 2026-06-07: node created (LLM gateway — global, key-isolated, multi-provider).
- 2026-06-08: expanded — capabilities (chat/embed/rerank/ocr), input/output modalities, resilient build (skip + onError).
