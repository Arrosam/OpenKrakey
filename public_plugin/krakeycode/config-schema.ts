import type { ConfigSchema } from "../../contracts/plugin";

export const KRAKEYCODE_SCHEMA: ConfigSchema = [
  { key: "mode", label: "Security mode", type: "enum", default: "sandbox",
    options: [
      { value: "sandbox", label: "Sandbox", summary: "Confined to this plugin's own workspace; safe default." },
      { value: "local", label: "Local", summary: "Absolute paths, full working-directory access — can touch any file on the computer." },
    ],
    help: "Default is Sandbox — file ops are confined to this plugin's workspace. Switch to Local to let Krakey read and modify files anywhere on the computer." },
  { key: "root", label: "Sandbox root", type: "string", placeholder: "(plugin data dir)", example: "./workspace", showIf: { key: "mode", equals: "sandbox" }, help: "File ops cannot escape this directory in sandbox mode. Resolved to an absolute path. Defaults to the plugin's own workspace." },
  { key: "allowWrite", label: "Allow file writes", type: "boolean", default: true, help: "Enables write_file and edit_file tools. Disable for read-only access." },
  { key: "allowCommands", label: "Allow shell commands", type: "boolean", default: false, help: "Enables the bash (shell) tool. OFF by default — turn it on to let Krakey run shell commands on the computer." },
  { key: "commandAllowlist", label: "Command allowlist", type: "list", default: [], placeholder: "git, ls, cat…", showIf: { key: "mode", equals: "sandbox" }, help: "Sandbox only. Empty list = allow all commands. Otherwise the first token of the command must appear here." },
  { key: "commandTimeoutMs", label: "Command timeout", type: "number", default: 60000, min: 1, step: 1000, unit: "ms", help: "Maximum wall-clock time a bash command may run." },
  { key: "maxReadBytes", label: "Max read bytes", type: "number", default: 1000000, min: 1, step: 1000, help: "Maximum bytes read_file may return." },
  { key: "maxOutputBytes", label: "Max shell output bytes", type: "number", default: 200000, min: 1, step: 1000, help: "Maximum bytes captured from bash stdout + stderr." },
  { key: "maxResults", label: "Results kept", type: "number", default: 10, min: 0, step: 1, help: "How many recent tool results are kept in the results ring." },
  { key: "maxResultChars", label: "Chars per result", type: "number", default: 4000, min: 1, step: 100, help: "Character cap per individual tool result injected into the prompt." },
  { key: "maxEntries", label: "Max directory entries", type: "number", default: 10000, min: 1, step: 100, help: "Maximum entries list_dir may return." },
  { key: "maxResultsTotalChars", label: "Total result chars", type: "number", default: 16000, min: 1, step: 100, help: "Total character budget across all results injected into the prompt." },
  { key: "guidance", label: "Guidance override", type: "text", placeholder: "(uses built-in guidance)", help: "Overrides the krakeycode.guidance system block text shown to the LLM." },
  { key: "guidancePriority", label: "Guidance block priority", type: "number", default: 7000, min: 0, step: 100 },
  { key: "resultsPriority", label: "Results block priority", type: "number", default: 4000, min: 0, step: 100 },
];
