# Node: llm-core (plugin)

## Purpose
The LLM round-trip plugin — the only thing that answers the orchestrator's `llm.request`. Picks a
communicator from the key-less `ctx.llm` library, sends the composed context, and reports the
normalized result back as `llm.return`. Also the tool-registration hub: provides the
`llm.register_tool` action so tool plugins can declare the ToolDefs sent with every chat request.

## Manifest
`{ id: "llm-core", version: "0.1.0", provides: ["llm.register_tool"] }`

## Config slice (`config["llm-core"]`)
`{ communicator?: string; temperature?: number; maxTokens?: number }` — `communicator` defaults to the
first name in `ctx.llm.withCapability("chat")`.

## Behavior (spec)
- setup registers action `llm.register_tool`: params = one L1 `ToolDef` (`{ name, description?,
  parameters? }`); rejects (throws) unless params is an object with a non-empty string `name`;
  registering the same name again REPLACES the stored def; returns `true`.
- setup subscribes `llm.request` (`Request<{ context: ComposedContext }>`):
  - Resolve the communicator (config name, else first chat-capable). If none exists or it lacks
    `chat`, emit `llm.return` `Reply{ id, at, ok: false, error }` and `ctx.log` a warning — never throw.
  - Else call `chat({ messages: [{ role: "user", content: context.text }], tools: <registered defs,
    omitted when none>, temperature?, maxTokens? })`.
  - Success → emit `llm.return` `Reply{ id, at, ok: true, data: LLMResponse }`; additionally, when
    `data.content` is non-empty, emit `output.message` `Notify{ at, data: { text: content, channel:
    undefined } }`.
  - Chat rejection → emit `llm.return` `Reply{ id, at, ok: false, error: String(err) }`.
  - The reply `id` ALWAYS equals the request `id`. Malformed request payloads (null/non-object/missing
    data.context) are ignored without throwing.
- teardown: unsubscribe the listener, unregister `llm.register_tool`.

## Status
done

## Change log
- 2026-06-11: node specced (Phase-1 MVP wave).
- 2026-06-11: implemented (Phase-1 MVP wave) — edge tests + e2e loop green.
