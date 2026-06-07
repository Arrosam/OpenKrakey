/**
 * Shared: actions — well-known action/event name constants (the cross-plugin vocabulary).
 */

/** Actions invoked on the actionbus. */
export const Actions = {
  LLM_CHAT: "llm.chat",
  LLM_EMBED: "llm.embed",
  LLM_OCR: "llm.ocr",
  LLM_RERANK: "llm.rerank",
  RESPONSE_PARSE: "response.parse",
} as const;

/** Events emitted on the eventbus. */
export const Events = {
  CLOCK_TICK: "clock.tick",
  INPUT_MESSAGE: "input.message",
  OUTPUT_MESSAGE: "output.message",
  TOOL_RESULT: "tool.result",
} as const;

export type ActionName = (typeof Actions)[keyof typeof Actions];
export type EventName = (typeof Events)[keyof typeof Events];
