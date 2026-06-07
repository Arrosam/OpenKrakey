# Node: cli

## Purpose
A standalone **interactive config tool** (a User Interface) built on `@inquirer/prompts` — arrow-key
pages to create/edit Agent config files, the Default Plugin Setting, and the LLM communicator catalogue
(`config/llm.json`). Decoupled from the runtime; a user could hand-edit the files instead. Shows the
Krakey ASCII logo.

## Zone
core

## Implements contracts
None.

## Depends on contracts
- `agent` — produces/edits `AgentDefinition` files.
- (Uses shared `config` for paths, `DefaultAgentSetting`, and `LLMConfig`/`CommunicatorDef`.)

## Exposed interface
- `createCli(deps: { agentsDir, defaultPath, publicPluginDir, llmPath, out? }): Cli` — exposes a PURE,
  testable file-ops core (no inquirer): `listAgents` / `readAgent` / `createAgent` (copy default; refuse
  if exists) / `writeAgent` / `removeAgent` (delete config only, keep data) / `readDefault` /
  `writeDefault` / `listAvailablePlugins` (dirs under `public_plugin/`) / `readLLMConfig` /
  `writeLLMConfig` / `listCommunicators`.
- `src/bin.ts` (shebang) parses argv → initial page → `runInteractiveLoop` (the inquirer shell, in
  `src/pages.ts`). `krakey` → landing; `krakey agent` → Agents; `krakey default` → Default.

## Internal structure
Testability seam: `src/index.ts` (pure ops, no inquirer) vs `src/pages.ts` (inquirer page flows) vs
`src/bin.ts` (argv + loop) vs `src/logo.ts`. Pages: Landing (Agents / Default / Providers / Quit),
Agents (list → select → Edit/Delete, or Create), Agent editor (intervalMs input; plugins/privatePlugins
multi-select sourced from `public_plugin/`; config per-key JSON), Default editor, Providers editor
(manage `config/llm.json` communicator defs — name/provider/model/baseURL; apiKey masked on display).
`CliError` = user-facing validation (caught + printed); unexpected fs errors bubble. Ctrl+C
(`ExitPromptError`) → Quit. Manages files only — never runs or talks to live agents.

## Status
pending

## Change log
- 2026-06-07: node created (skeleton, post-rewrite).
- 2026-06-07: redesigned — interactive @inquirer/prompts TUI (landing + deep-links + Providers page) instead of slash commands.
