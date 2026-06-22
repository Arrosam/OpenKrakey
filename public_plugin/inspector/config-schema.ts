import type { ConfigSchema } from "../../contracts/plugin";

export const INSPECTOR_SCHEMA: ConfigSchema = [
  { key: "port", label: "Port", type: "number", default: 7719, min: 1, max: 65535, step: 1, help: "The inspector dashboard server binds here. Sequenced after web-chat (7718) to avoid collisions." },
  { key: "host", label: "Bind host", type: "string", default: "127.0.0.1", placeholder: "127.0.0.1", help: "Loopback by default." },
  { key: "token", label: "Session token", type: "secret", placeholder: "(random per run)", help: "Pin a fixed token (≥ 16 url-safe chars) or leave blank for a fresh random one each run." },
  { key: "bufferSize", label: "Event buffer size", type: "number", default: 1000, min: 1, step: 1, help: "Ring-buffer length for captured beat records." },
  { key: "maxRecordBytes", label: "Max record bytes", type: "number", default: 65536, min: 1, step: 1024, help: "Maximum byte size of a single captured event record." },
];
