# Package: llm-gateway

Global LLM communication gateway. Builds a **key-less** `CommunicatorLibrary` from `config/llm.json`
(provider adapters: anthropic + openai-compatible; native `fetch`). Each communicator does request +
parse internally; API keys stay in the closure and are never exposed to plugins.

- Overview: [`../../overviews/nodes/llm-gateway.md`](../../overviews/nodes/llm-gateway.md)
- Implements: `llm` (Communicator/CommunicatorLibrary) · Depends on: `llm` (envelope), shared `config`
- Status: **pending**

Source under `src/`. Import only `../../contracts/*` and `../../shared/*`. Never edit contracts/ or shared/.
