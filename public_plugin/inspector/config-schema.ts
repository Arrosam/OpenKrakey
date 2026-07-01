import type { ConfigSchema } from "../../contracts/plugin";

export const INSPECTOR_SCHEMA: ConfigSchema = [
  { key: "port", label: "Port", type: "number", default: 7719, min: 1, max: 65535, step: 1, help: "The inspector dashboard server binds here. Sequenced after web-chat (7718) to avoid collisions." },
  { key: "host", label: "Bind host", type: "string", default: "127.0.0.1", placeholder: "127.0.0.1", help: "Loopback by default." },
  { key: "token", label: "Session token", type: "secret", placeholder: "(random per run)", help: "Pin a fixed token (≥ 16 url-safe chars) or leave blank for a fresh random one each run." },
  { key: "bufferSize", label: "Event buffer size", type: "number", default: 1000, min: 1, step: 1, help: "Ring-buffer length for captured frame records." },
  { key: "maxRecordBytes", label: "Max record bytes", type: "number", default: 65536, min: 1, step: 1024, help: "Maximum byte size of a single captured event record." },
  { key: "persist", label: "Persist history", type: "boolean", default: true, help: "Write captured records to a per-agent JSONL file under the data dir so the Logs view can restore history across restarts." },
  { key: "maxPersistedEntries", label: "Max persisted entries", type: "number", default: 5000, min: 1, step: 100, help: "Cap on persisted records per agent. The file is compacted back down once it grows past twice this." },
  { key: "retentionMs", label: "Retention (ms)", type: "number", default: 0, min: 0, step: 60000, unit: "ms", help: "On restore, drop persisted records older than this many ms. 0 = keep everything (60000 = 1 minute)." },
];
