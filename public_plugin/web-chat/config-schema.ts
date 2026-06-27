import type { ConfigSchema } from "../../contracts/plugin";

export const WEB_SCHEMA: ConfigSchema = [
  { key: "port", label: "Port", type: "number", default: 7718, min: 1, max: 65535, step: 1, help: "The browser chat server binds here." },
  { key: "host", label: "Bind host", type: "string", default: "127.0.0.1", placeholder: "127.0.0.1", example: "127.0.0.1 (loopback) · 0.0.0.0 (all interfaces)", help: "Loopback by default — not LAN-reachable. Any bind address the OS accepts." },
  { key: "token", label: "Session token", type: "secret", placeholder: "(random per run)", help: "Pin a fixed token (≥ 16 url-safe chars) or leave blank for a fresh random one each run. An invalid configured token is rejected silently." },
  { key: "guidance", label: "Channel guidance", type: "text", placeholder: "(uses built-in guidance)", help: "Overrides the web-chat.guidance system-block text shown to the LLM." },
  { key: "guidancePriority", label: "Guidance block priority", type: "number", default: 8000, min: 0, step: 100, help: "Priority of the web-chat.guidance system block." },
  { key: "conversationMaxTurns", label: "Conversation window — turns", type: "number", default: 60, min: 1, step: 1, help: "How many recent conversation turns are fed back to the LLM each frame." },
  { key: "conversationMaxChars", label: "Conversation window — chars", type: "number", default: 24000, min: 1, step: 100, help: "Character budget for the conversation window." },
];
