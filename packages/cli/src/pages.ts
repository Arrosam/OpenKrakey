/**
 * cli — the interactive shell. The ONLY module (besides bin.ts) that imports
 * `@inquirer/prompts` (via ./theme). Everything stateful-fs goes through the
 * pure `Cli` core.
 *
 * Control flow: a loop over a current-page name. Each page is a local async
 * function that performs prompts + cli ops and returns the NEXT page name (or
 * "quit"). Every select menu carries an explicit exit entry (Back / Cancel /
 * Done / Quit), and Ctrl+C anywhere DROPS the current action — unsaved edits
 * are abandoned and the loop returns to the main menu; Ctrl+C at the main menu
 * quits. Expected CliErrors are printed and the loop continues; anything else
 * bubbles out.
 */
import {
  STAR,
  bold,
  checkbox,
  confirm,
  dim,
  failure,
  heading,
  input,
  mint,
  password,
  red,
  select,
  step,
  success,
} from "./theme";

import type { AgentDefinition } from "../../../contracts/agent";
import type { Capability, Modality } from "../../../contracts/llm";
import type {
  CommunicatorDef,
  DefaultAgentSetting,
  LLMConfig,
  ProviderInfo,
} from "../../../shared/config";
import {
  CAPABILITY_LABELS,
  KNOWN_PROVIDERS,
  MODALITY_LABELS,
} from "../../../shared/config";

import { CliError, CliParseError, normalizeBaseURL, type Cli } from "./index";
import { KRAKEY_LOGO } from "./logo";

export type InitialPage = "landing" | "agents" | "default" | "providers";

/** Internal page space: the entry pages plus the wizard and "quit". */
type Page = InitialPage | "wizard" | "quit";

/**
 * Raised when the user hits Ctrl+C (inquirer's ExitPromptError) — means "drop
 * what I'm doing": the main loop abandons the current page and returns to the
 * main menu (and quits when already there).
 */
class QuitSignal {}

const isExitPromptError = (err: unknown): boolean =>
  err instanceof Error && err.name === "ExitPromptError";

/** Run an inquirer prompt; turn a Ctrl+C into our QuitSignal sentinel. */
async function ask<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isExitPromptError(err)) throw new QuitSignal();
    throw err;
  }
}

type Out = (msg: string) => void;

// Shared action labels, color-coded by intent: mint = constructive/affirmative,
// red = destructive (or loses your edits), dim = plain navigation. Whole names
// are painted (never substrings) so the focused-row highlight stays readable.
const BACK = dim("← Back");
const CREATE_NEW = mint("+ Create new");
const ADD_SERVICE = mint("+ Add a new AI service");
const DONE = mint("Done");

/** Reusable id validator for agent ids: non-empty, no spaces/slashes/dot-dirs. */
function validateId(raw: string): true | string {
  const v = raw.trim();
  if (v.length === 0) return "name must not be empty";
  if (v === "." || v === "..") return "name must not be '.' or '..'";
  if (/[\s/\\]/.test(v)) return "name must not contain spaces or slashes";
  return true;
}

/** Parse a positive integer from free text; undefined if not a positive int. */
function parsePositiveInt(raw: string): number | undefined {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 ? n : undefined;
}

/** Parse a finite, non-negative number (int or float); undefined otherwise. */
function parseNonNegativeFloat(raw: string): number | undefined {
  const v = raw.trim();
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Reasoning-effort levels offered for reasoning-capable providers. */
const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

// ── Provider-catalogue helpers (selects + format hints from shared/config) ───

/** Catalogue entry for a provider id; undefined for an unknown/legacy id. */
const providerInfo = (id: string | undefined): ProviderInfo | undefined =>
  KNOWN_PROVIDERS.find((p) => p.id === id);

/** Natural-language label for a provider id (falls back to the raw id). */
const providerLabel = (id: string | undefined): string =>
  providerInfo(id)?.label ?? (id || "(not set)");

/** One-line UI descriptions for the known plugins (bare id for unknown ones). */
const PLUGIN_SUMMARIES: Record<string, string> = {
  "llm-core": "talks to the AI service (required for replies)",
  persona: "the agent's identity / system prompt",
  history: "conversation memory (Hermes-format messages)",
  web: "chat with the agent from your browser",
};
const pluginChoice = (id: string, checked: boolean) => ({
  name: PLUGIN_SUMMARIES[id] ? `${id} — ${PLUGIN_SUMMARIES[id]}` : id,
  value: id,
  checked,
});

/**
 * Pick a provider TYPE (the wire format) from the catalogue — never free text.
 * The last entry cancels (returns null); callers keep their current value or
 * abort their flow.
 */
const selectProviderType = (
  current: string | undefined,
  cancelLabel: string,
): Promise<ProviderInfo | null> =>
  ask(() =>
    select<ProviderInfo | null>({
      message: "provider type — the wire format your endpoint speaks",
      choices: [
        ...KNOWN_PROVIDERS.map((p) => ({
          name: `${p.label} — ${p.summary}`,
          value: p as ProviderInfo | null,
        })),
        { name: dim(cancelLabel), value: null },
      ],
      default: providerInfo(current),
      loop: false,
    }),
  );

/**
 * Model id prompt with the provider's format example. Empty means "go back"
 * (returns "" — the caller keeps its current value or aborts its flow).
 */
const askModel = (info: ProviderInfo | undefined, current: string): Promise<string> =>
  ask(() =>
    input({
      message: `model id — as your provider names it (e.g. ${info?.modelExample ?? "gpt-4o"}; leave empty to go back)`,
      default: current,
    }),
  ).then((v) => v.trim());

/** Endpoint URL prompt with the provider's format hint; normalized on entry. */
const askBaseURL = (
  info: ProviderInfo | undefined,
  current: string,
): Promise<string | undefined> =>
  ask(() =>
    input({
      message: `endpoint URL — ${info?.baseURLHint ?? "leave blank for the provider default"} (e.g. ${info?.baseURLExample ?? "https://api.example.com/v1"})`,
      default: current,
    }),
  ).then(normalizeBaseURL);

/** Capability checkbox limited to what the chosen provider type can serve. */
const askCapabilities = (
  info: ProviderInfo,
  current: Capability[],
): Promise<Capability[]> =>
  ask(() =>
    checkbox<Capability>({
      message: "used for — what this connection will serve",
      choices: info.capabilities.map((c) => ({
        name: CAPABILITY_LABELS[c],
        value: c,
        checked: current.includes(c),
      })),
      validate: (sel) => (sel.length > 0 ? true : "pick at least one"),
      loop: false,
    }),
  );

/** Modality checkbox limited to what the chosen provider type supports. */
const askModalities = (
  kind: "input" | "output",
  allowed: Modality[],
  current: Modality[],
): Promise<Modality[]> =>
  ask(() =>
    checkbox<Modality>({
      message:
        kind === "input"
          ? "input types — what the model accepts"
          : "output types — what the model produces",
      choices: allowed.map((m) => ({
        name: MODALITY_LABELS[m],
        value: m,
        checked: current.includes(m),
      })),
      validate: (sel) => (sel.length > 0 ? true : "pick at least one"),
      loop: false,
    }),
  );

export async function runInteractiveLoop(
  cli: Cli,
  initialPage: InitialPage = "landing",
  out: Out = console.log,
): Promise<void> {
  /** Run a cli op; on the expected CliError print it and yield a fallback. */
  async function guard<T>(op: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await op();
    } catch (err) {
      if (err instanceof CliError) {
        out(failure(err.message));
        return fallback;
      }
      throw err;
    }
  }

  // ── Config record per-key editor ───────────────────────────────────────────
  /** Edit a `Record<string, unknown>` in place-ish; returns the new object. */
  async function editConfig(
    current: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const cfg: Record<string, unknown> = { ...current };

    for (;;) {
      const keys = Object.keys(cfg).sort();
      const choices = [
        ...keys.map((k) => ({
          name: `${k}: ${JSON.stringify(cfg[k])}`,
          value: `edit:${k}`,
        })),
        { name: mint("+ Add key"), value: "add" },
        { name: red("Remove key"), value: "remove" },
        { name: DONE, value: "done" },
      ];

      const action = await ask(() =>
        select({
          message: "plugin settings — per-plugin JSON config, keyed by plugin id",
          choices,
          loop: false,
        }),
      );

      if (action === "done") return cfg;

      if (action === "add") {
        const key = (
          await ask(() =>
            input({ message: "new key name (leave empty to go back)" }),
          )
        ).trim();
        if (key === "") continue;
        const valueRaw = await ask(() =>
          input({ message: `value for "${key}" (JSON)`, default: '""' }),
        );
        try {
          cfg[key] = JSON.parse(valueRaw) as unknown;
        } catch {
          out("invalid JSON, key not added");
        }
        continue;
      }

      if (action === "remove") {
        if (keys.length === 0) {
          out("no keys to remove");
          continue;
        }
        const key = await ask(() =>
          select({
            message: "remove which key?",
            choices: [
              ...keys.map((k) => ({ name: k, value: k })),
              { name: BACK, value: "\0back" },
            ],
            loop: false,
          }),
        );
        if (key !== "\0back") delete cfg[key];
        continue;
      }

      // edit:<key>
      const key = action.slice("edit:".length);
      const valueRaw = await ask(() =>
        input({
          message: `value for "${key}" (JSON)`,
          default: JSON.stringify(cfg[key]),
        }),
      );
      try {
        cfg[key] = JSON.parse(valueRaw) as unknown;
      } catch {
        out("invalid JSON, unchanged");
      }
    }
  }

  /**
   * Edit a list of stop sequences (free strings). Returns the new list (empty
   * when the user removes them all). Each entry is a literal string the model
   * must not produce; ordering is preserved.
   */
  async function editStopSequences(current: string[]): Promise<string[]> {
    const list = [...current];
    for (;;) {
      const action = await ask(() =>
        select({
          message: "stop sequences — generation halts when the model produces any of these",
          choices: [
            ...list.map((s, i) => ({
              name: `${JSON.stringify(s)}`,
              value: `remove:${i}`,
            })),
            { name: mint("+ Add a stop sequence"), value: "add" },
            { name: DONE, value: "done" },
          ],
          loop: false,
        }),
      );

      if (action === "done") return list;

      if (action === "add") {
        const seq = await ask(() =>
          input({
            message: "stop sequence to add (leave empty to go back)",
          }),
        );
        if (seq !== "") list.push(seq);
        continue;
      }

      // remove:<index>
      const idx = Number(action.slice("remove:".length));
      if (Number.isInteger(idx) && idx >= 0 && idx < list.length) list.splice(idx, 1);
    }
  }

  // ── Shared agent/default field editor ──────────────────────────────────────
  /**
   * Edit the four shared setting fields (intervalMs / plugins / privatePlugins /
   * config) on a draft. Returns true on Save, false on Discard.
   */
  async function editSettingFields(
    label: string,
    draft: {
      intervalMs: number;
      plugins: string[];
      privatePlugins?: string[];
      config?: Record<string, unknown>;
    },
    availablePlugins: string[],
  ): Promise<boolean> {
    for (;;) {
      const field = await ask(() =>
        select({
          message: `${label} — pick a field`,
          choices: [
            {
              name: `Frame interval: ${draft.intervalMs} ms — how often the agent acts unprompted`,
              value: "intervalMs",
            },
            {
              name: `Plugins to load: [${draft.plugins.join(", ")}]`,
              value: "plugins",
            },
            {
              name: `Private plugin copies: [${(draft.privatePlugins ?? []).join(", ")}]`,
              value: "privatePlugins",
            },
            {
              name: `Plugin settings: ${Object.keys(draft.config ?? {}).length} item(s)`,
              value: "config",
            },
            { name: mint("Save & Back"), value: "save" },
            { name: red("Discard & Back"), value: "discard" },
          ],
          loop: false,
        }),
      );

      if (field === "save") return true;
      if (field === "discard") return false;

      if (field === "intervalMs") {
        const raw = await ask(() =>
          input({
            message: "frame interval in milliseconds (60000 = 1 minute)",
            default: String(draft.intervalMs),
            validate: (r) =>
              parsePositiveInt(r) !== undefined
                ? true
                : "must be a positive whole number of milliseconds",
          }),
        );
        const n = parsePositiveInt(raw);
        if (n !== undefined) draft.intervalMs = n;
        continue;
      }

      if (field === "plugins") {
        if (availablePlugins.length === 0) {
          out("No public plugins found in public_plugin/ — nothing to choose.");
          continue;
        }
        draft.plugins = await ask(() =>
          checkbox({
            message: "plugins to load — what this agent can do",
            choices: availablePlugins.map((p) =>
              pluginChoice(p, draft.plugins.includes(p)),
            ),
            loop: false,
          }),
        );
        continue;
      }

      if (field === "privatePlugins") {
        if (availablePlugins.length === 0) {
          out("No public plugins found in public_plugin/ — nothing to choose.");
          continue;
        }
        const picked = await ask(() =>
          checkbox({
            message:
              "private plugin copies — these get their own isolated data under this agent (instead of sharing the public plugin's data)",
            choices: availablePlugins.map((p) =>
              pluginChoice(p, (draft.privatePlugins ?? []).includes(p)),
            ),
            loop: false,
          }),
        );
        draft.privatePlugins = picked.length > 0 ? picked : undefined;
        continue;
      }

      // config
      draft.config = await editConfig(draft.config ?? {});
    }
  }

  // ── Agent editor ───────────────────────────────────────────────────────────
  async function agentEditor(id: string): Promise<void> {
    const def = await guard<AgentDefinition | null>(
      () => cli.readAgent(id),
      null,
    );
    if (def === null) return;
    const plugins = await guard(() => cli.listAvailablePlugins(), []);

    const draft: AgentDefinition = {
      id: def.id,
      intervalMs: def.intervalMs,
      plugins: [...def.plugins],
      privatePlugins: def.privatePlugins ? [...def.privatePlugins] : undefined,
      config: def.config ? { ...def.config } : undefined,
    };

    const save = await editSettingFields(`Agent "${id}"`, draft, plugins);
    if (save) {
      await guard(() => cli.writeAgent(id, draft), undefined);
      out(success(`Saved agent "${id}".`));
    }
  }

  // ── Pages ──────────────────────────────────────────────────────────────────
  async function landingPage(): Promise<Page> {
    out(KRAKEY_LOGO);
    // Lead with the guided setup until something exists; afterwards it moves
    // below the everyday entries. Either way it is just a menu item — skippable.
    const agents = await guard(() => cli.listAgents(), []);
    const services = await guard(() => cli.listCommunicators(), []);
    const fresh = agents.length === 0 || services.length === 0;
    const wizardEntry = {
      name: fresh
        ? `${STAR} Guided setup — connect an AI service and create your first agent`
        : `${STAR} Guided setup — add another AI service + agent`,
      value: "wizard" as Page,
    };
    const main: Array<{ name: string; value: Page }> = [
      { name: "Agents — create and edit your agents", value: "agents" },
      { name: "Default settings — the template new agents copy", value: "default" },
      { name: "AI services — LLM providers, endpoints, API keys", value: "providers" },
    ];
    return ask(() =>
      select<Page>({
        message: "OpenKrakey config",
        choices: [
          ...(fresh ? [wizardEntry, ...main] : [...main, wizardEntry]),
          { name: dim("Quit"), value: "quit" },
        ],
        loop: false,
      }),
    );
  }

  async function agentsPage(): Promise<Page> {
    const ids = await guard(() => cli.listAgents(), []);
    const choice = await ask(() =>
      select<string>({
        message: "Agents",
        choices: [
          ...ids.map((id) => ({ name: id, value: id })),
          { name: CREATE_NEW, value: "\0create" },
          { name: BACK, value: "\0back" },
        ],
        loop: false,
      }),
    );

    if (choice === "\0back") return "landing";

    if (choice === "\0create") {
      const id = (
        await ask(() =>
          input({
            message:
              "agent name — used as its folder under agents/ (letters, digits, . _ -; leave empty to go back)",
            validate: (r) => (r.trim() === "" ? true : validateId(r)),
          }),
        )
      ).trim();
      if (id === "") return "agents";
      await guard(() => cli.createAgent(id), undefined);
      return "agents";
    }

    // Selected an existing agent id → detail. Deleting uses the same two-step
    // arm-and-confirm as AI services: first ENTER arms, second ENTER deletes,
    // any other selection disarms.
    let armedDelete = false;
    for (;;) {
      const action = await ask(() =>
        select<"edit" | "delete" | "back">({
          message: `Agent "${choice}"`,
          choices: [
            { name: "Edit", value: "edit" },
            {
              name: armedDelete
                ? red(bold(`Press ENTER again to DELETE "${choice}" (config only — data kept)`))
                : red("Delete config"),
              value: "delete",
            },
            { name: BACK, value: "back" },
          ],
          default: armedDelete ? "delete" : undefined,
          loop: false,
        }),
      );

      if (action === "delete") {
        if (!armedDelete) {
          armedDelete = true;
          continue;
        }
        await guard(() => cli.removeAgent(choice), undefined);
        out(success(`Removed config for "${choice}".`));
        return "agents";
      }
      if (action === "edit") {
        await agentEditor(choice);
      }
      return "agents";
    }
  }

  async function defaultPage(): Promise<Page> {
    // A corrupt default file: print + bail to landing rather than offer a seed
    // that would overwrite it. Absent (plain CliError) → offer to seed below.
    let setting: DefaultAgentSetting | null;
    try {
      setting = await cli.readDefault();
    } catch (err) {
      if (err instanceof CliParseError) {
        out(failure(err.message));
        return "landing";
      }
      if (err instanceof CliError) {
        out(failure(err.message));
        setting = null;
      } else {
        throw err;
      }
    }
    if (setting === null) {
      // No default yet → offer to seed an empty one.
      const create = await ask(() =>
        confirm({
          message: "No default setting found. Create one now?",
          default: true,
        }),
      );
      if (!create) return "landing";
      setting = { intervalMs: 1000, plugins: [] };
    }

    const plugins = await guard(() => cli.listAvailablePlugins(), []);
    const draft: DefaultAgentSetting = {
      intervalMs: setting.intervalMs,
      plugins: [...setting.plugins],
      privatePlugins: setting.privatePlugins
        ? [...setting.privatePlugins]
        : undefined,
      config: setting.config ? { ...setting.config } : undefined,
    };

    const save = await editSettingFields("Default setting", draft, plugins);
    if (save) {
      await guard(() => cli.writeDefault(draft), undefined);
      out(success("Saved default settings."));
    }
    return "landing";
  }

  // ── AI services (LLM communicators) ─────────────────────────────────────────
  /** Edit one communicator def on `cfg` under `name`; returns true on Save. */
  async function communicatorEditor(
    cfg: LLMConfig,
    name: string,
    isNew: boolean,
  ): Promise<boolean> {
    // Seed the draft from the full existing def so fields we never edit
    // (temperature/maxTokens/…) survive a Save.
    const existing: CommunicatorDef = cfg.communicators[name] ?? {
      provider: "",
      model: "",
    };

    // The provider TYPE drives everything else (allowed capabilities, URL and
    // model format hints) — for a new connection, pick it first; cancelling
    // there drops the whole edit.
    let info = providerInfo(existing.provider);
    if (isNew || info === undefined) {
      const picked = await selectProviderType(existing.provider, "← Cancel");
      if (picked === null) return false;
      info = picked;
    }

    const draft = {
      provider: info.id,
      model: existing.model,
      baseURL: existing.baseURL,
      apiKey: existing.apiKey,
      capabilities: (existing.capabilities ?? info.defaultCapabilities) as Capability[],
      input: (existing.input ?? ["text"]) as Modality[],
      output: (existing.output ?? ["text"]) as Modality[],
      topP: existing.topP,
      stop: existing.stop ? [...existing.stop] : undefined,
      reasoningEffort: existing.reasoningEffort,
      contextLength: existing.contextLength,
    };
    // A blank baseURL only REMOVES the field when the user explicitly cleared it;
    // an untouched baseURL is preserved as-is.
    let baseURLCleared = false;
    // Deleting is a two-step arm-and-confirm: the first ENTER arms (the entry
    // turns into an explicit warning and keeps the cursor), the second ENTER
    // deletes. Picking anything else disarms.
    let armedDelete = false;

    /** Keep selections legal after a provider-type change. */
    const clampToProvider = () => {
      const p = info!;
      draft.capabilities = draft.capabilities.filter((c) => p.capabilities.includes(c));
      if (draft.capabilities.length === 0) draft.capabilities = [...p.defaultCapabilities];
      draft.input = draft.input.filter((m) => p.inputs.includes(m));
      if (draft.input.length === 0) draft.input = ["text"];
      draft.output = draft.output.filter((m) => p.outputs.includes(m));
      if (draft.output.length === 0) draft.output = ["text"];
      // reasoningEffort only applies to reasoning-capable providers — drop it
      // when switching to a type that has no effort setting.
      if (!p.supportsReasoningEffort) draft.reasoningEffort = undefined;
    };
    clampToProvider();

    for (;;) {
      const maskedKey =
        draft.apiKey === undefined || draft.apiKey === "" ? "(not set)" : "***";
      const field = await ask(() =>
        select({
          message: isNew ? `New AI service "${name}"` : `AI service "${name}"`,
          choices: [
            { name: `Provider type: ${providerLabel(draft.provider)}`, value: "provider" },
            { name: `Model: ${draft.model || "(not set)"}`, value: "model" },
            {
              name: `Endpoint URL: ${draft.baseURL ?? "(provider default)"}`,
              value: "baseURL",
            },
            { name: `API key: ${maskedKey}`, value: "apiKey" },
            {
              name: `Used for: ${draft.capabilities.map((c) => CAPABILITY_LABELS[c]).join(", ")}`,
              value: "capabilities",
            },
            {
              name: `Input types: ${draft.input.map((m) => MODALITY_LABELS[m]).join(", ")}`,
              value: "input",
            },
            {
              name: `Output types: ${draft.output.map((m) => MODALITY_LABELS[m]).join(", ")}`,
              value: "output",
            },
            {
              name: `Top-p (nucleus sampling): ${draft.topP ?? "(provider default)"}`,
              value: "topP",
            },
            ...(info!.supportsReasoningEffort
              ? [
                  {
                    name: `Reasoning effort: ${draft.reasoningEffort ?? "(provider default)"}`,
                    value: "reasoningEffort",
                  },
                ]
              : []),
            {
              name: `Stop sequences: ${draft.stop && draft.stop.length > 0 ? draft.stop.join(", ") : "(none)"}`,
              value: "stop",
            },
            {
              name: `Context length: ${draft.contextLength ?? "(provider default)"} ${draft.contextLength ? "tokens" : ""}`.trimEnd(),
              value: "contextLength",
            },
            { name: mint("Save"), value: "save" },
            // Delete only applies to an EXISTING communicator, not a new one.
            ...(isNew
              ? []
              : [
                  {
                    name: armedDelete
                      ? red(bold(`Press ENTER again to DELETE "${name}"`))
                      : red("Delete this service"),
                    value: "delete",
                  },
                ]),
            { name: dim("Cancel"), value: "cancel" },
          ],
          // While armed, keep the cursor ON the delete entry so the second
          // ENTER lands there — that is the whole double-enter contract.
          default: armedDelete ? "delete" : undefined,
          loop: false,
        }),
      );

      if (field === "delete") {
        if (!armedDelete) {
          armedDelete = true;
          continue;
        }
        delete cfg.communicators[name];
        if (cfg.default === name) delete cfg.default;
        return true;
      }
      // Any other selection disarms a pending delete.
      armedDelete = false;

      if (field === "cancel") return false;

      if (field === "save") {
        if (draft.model.trim() === "") {
          out("enter a model id before saving");
          continue;
        }
        const def: CommunicatorDef = {
          ...existing,
          provider: draft.provider,
          model: draft.model,
          capabilities: [...draft.capabilities],
          input: [...draft.input],
          output: [...draft.output],
        };
        if (draft.baseURL) def.baseURL = draft.baseURL;
        else if (baseURLCleared) delete def.baseURL;
        if (draft.apiKey) def.apiKey = draft.apiKey;
        // Optional tuning fields — set when present, dropped when cleared.
        if (draft.topP !== undefined) def.topP = draft.topP;
        else delete def.topP;
        if (draft.stop && draft.stop.length > 0) def.stop = [...draft.stop];
        else delete def.stop;
        if (draft.reasoningEffort !== undefined) def.reasoningEffort = draft.reasoningEffort;
        else delete def.reasoningEffort;
        if (draft.contextLength !== undefined) def.contextLength = draft.contextLength;
        else delete def.contextLength;
        cfg.communicators[name] = def;
        return true;
      }

      if (field === "provider") {
        const picked = await selectProviderType(draft.provider, "← Keep current type");
        if (picked !== null) {
          info = picked;
          draft.provider = info.id;
          clampToProvider();
        }
      } else if (field === "model") {
        const m = await askModel(info, draft.model);
        if (m !== "") draft.model = m; // empty = go back, keep the current id
      } else if (field === "baseURL") {
        const v = await askBaseURL(info, draft.baseURL ?? "");
        draft.baseURL = v;
        baseURLCleared = v === undefined;
      } else if (field === "capabilities") {
        draft.capabilities = await askCapabilities(info, draft.capabilities);
      } else if (field === "input") {
        draft.input = await askModalities("input", info.inputs, draft.input);
      } else if (field === "output") {
        draft.output = await askModalities("output", info.outputs, draft.output);
      } else if (field === "topP") {
        const raw = await ask(() =>
          input({
            message:
              "top-p — nucleus-sampling cutoff between 0 and 1 (e.g. 0.9; leave empty to clear / use the provider default)",
            default: draft.topP !== undefined ? String(draft.topP) : "",
            validate: (r) => {
              const v = r.trim();
              if (v === "") return true; // empty = clear
              const n = parseNonNegativeFloat(v);
              return n !== undefined && n <= 1
                ? true
                : "must be a number between 0 and 1";
            },
          }),
        );
        const v = raw.trim();
        draft.topP = v === "" ? undefined : parseNonNegativeFloat(v);
      } else if (field === "reasoningEffort") {
        draft.reasoningEffort = await ask(() =>
          select<string | undefined>({
            message: "reasoning effort — how hard a reasoning-capable model thinks before answering",
            choices: [
              { name: dim("(provider default)"), value: undefined },
              ...REASONING_EFFORTS.map((e) => ({ name: e, value: e as string })),
            ],
            default: draft.reasoningEffort,
            loop: false,
          }),
        );
      } else if (field === "stop") {
        draft.stop = await editStopSequences(draft.stop ?? []);
      } else if (field === "contextLength") {
        const raw = await ask(() =>
          input({
            message:
              "context length — the model's context-window size in tokens (metadata only, e.g. 200000; leave empty to clear)",
            default: draft.contextLength !== undefined ? String(draft.contextLength) : "",
            validate: (r) => {
              const v = r.trim();
              if (v === "") return true; // empty = clear
              return parsePositiveInt(v) !== undefined
                ? true
                : "must be a positive whole number of tokens";
            },
          }),
        );
        const v = raw.trim();
        draft.contextLength = v === "" ? undefined : parsePositiveInt(v);
      } else {
        // apiKey — masked entry; never pre-fill; blank keeps the current value.
        const v = await ask(() =>
          password({
            message:
              "API key — stored locally in config/llm.json (gitignored); use ${ENV_VAR} to reference an environment variable; blank keeps the current value",
            mask: true,
          }),
        );
        if (v.trim() !== "") draft.apiKey = v;
      }
    }
  }

  async function providersPage(): Promise<Page> {
    // A corrupt catalogue may hold API keys: print + bail to landing rather than
    // risk overwriting it with an edit. Absent → empty catalogue (guard fallback).
    let cfg: LLMConfig;
    try {
      cfg = await cli.readLLMConfig();
    } catch (err) {
      if (err instanceof CliParseError) {
        out(failure(err.message));
        return "landing";
      }
      if (err instanceof CliError) {
        out(failure(err.message));
        cfg = { communicators: {} };
      } else {
        throw err;
      }
    }
    const names = Object.keys(cfg.communicators).sort();

    const choice = await ask(() =>
      select<string>({
        message: "AI services — the LLM connections your agents can use",
        choices: [
          ...names.map((n) => {
            const def = cfg.communicators[n];
            return {
              name: `${n} — ${providerLabel(def?.provider)} · ${def?.model || "(no model)"}`,
              value: n,
            };
          }),
          { name: ADD_SERVICE, value: "\0add" },
          { name: BACK, value: "\0back" },
        ],
        loop: false,
      }),
    );

    if (choice === "\0back") return "landing";

    const isNew = choice === "\0add";
    let name: string;
    if (isNew) {
      name = (
        await ask(() =>
          input({
            message:
              "connection name — a short name you'll refer to this service by (e.g. claude, gpt, local; leave empty to go back)",
            validate: (r) => {
              const v = r.trim();
              if (v.length === 0) return true; // empty = go back
              if (cfg.communicators[v]) return `"${v}" already exists`;
              return true;
            },
          }),
        )
      ).trim();
      if (name === "") return "providers";
    } else {
      name = choice;
    }

    const changed = await communicatorEditor(cfg, name, isNew);
    if (changed) {
      await guard(() => cli.writeLLMConfig(cfg), undefined);
      out(success("Saved AI services."));
    }
    return "providers";
  }

  // ── Guided setup ─────────────────────────────────────────────────────────
  /**
   * One straight line from nothing to a talking agent: provider type →
   * connection name → model → endpoint → key, then agent name → persona.
   * Skippable by design (it is just a landing menu entry; Ctrl+C leaves like
   * everywhere else). Every prompt states what the field is for and the
   * expected format — no other hand-holding.
   */
  async function wizardPage(): Promise<Page> {
    // Read the catalogue up front; a corrupt llm.json aborts (never overwritten).
    let cfg: LLMConfig;
    try {
      cfg = await cli.readLLMConfig();
    } catch (err) {
      if (err instanceof CliError) {
        out(failure(err.message));
        return "landing";
      }
      throw err;
    }

    out("");
    out(
      heading(
        "Guided setup",
        "Connect an AI service, then create an agent that uses it. Ctrl+C drops you back to the menu at any point.",
      ),
    );
    out(step("Step 1 of 2 — the AI service"));

    // 1. The AI service.
    const info = await selectProviderType(undefined, "← Cancel setup");
    if (info === null) return "landing";
    const connName = (
      await ask(() =>
        input({
          message:
            "connection name — a short name you'll refer to this service by (e.g. claude, gpt, local; leave empty to cancel)",
          validate: (r) => {
            const v = r.trim();
            if (v.length === 0) return true; // empty = cancel setup
            if (cfg.communicators[v]) return `"${v}" already exists`;
            return true;
          },
        }),
      )
    ).trim();
    if (connName === "") {
      out(dim("(cancelled — nothing saved)"));
      return "landing";
    }
    const model = await askModel(info, "");
    if (model === "") {
      out(dim("(cancelled — nothing saved)"));
      return "landing";
    }
    const baseURL = await askBaseURL(info, "");
    const apiKey = await ask(() =>
      password({
        message:
          "API key — stored locally in config/llm.json (gitignored); use ${ENV_VAR} to reference an environment variable",
        mask: true,
        validate: (r) =>
          r.trim().length > 0
            ? true
            : "a key is required — for keyless local servers enter anything (e.g. none)",
      }),
    );

    const def: CommunicatorDef = {
      provider: info.id,
      model,
      apiKey,
      capabilities: [...info.defaultCapabilities],
    };
    if (baseURL) def.baseURL = baseURL;
    cfg.communicators[connName] = def;
    const wrote = await guard(async () => {
      await cli.writeLLMConfig(cfg);
      return true;
    }, false);
    if (!wrote) return "landing";
    out(success(`Saved AI service "${connName}".`));

    // 2. The agent.
    out(step("Step 2 of 2 — your agent"));
    const wantAgent = await ask(() =>
      confirm({ message: "Create an agent that uses it now?", default: true }),
    );
    if (!wantAgent) return "landing";

    const agentId = (
      await ask(() =>
        input({
          message:
            "agent name — used as its folder under agents/ (letters, digits, . _ -; e.g. krakey; leave empty to skip)",
          validate: (r) => (r.trim() === "" ? true : validateId(r)),
        }),
      )
    ).trim();
    if (agentId === "") {
      out(dim(`(agent creation skipped — the AI service "${connName}" was saved)`));
      return "landing";
    }

    // createAgent copies the Default Setting; seed a sensible one if absent
    // (every available public plugin, 30 s frame interval). A corrupt default aborts.
    try {
      await cli.readDefault();
    } catch (err) {
      if (err instanceof CliParseError) {
        out(failure(err.message));
        return "landing";
      }
      if (err instanceof CliError) {
        const available = await guard(() => cli.listAvailablePlugins(), []);
        // Data-carrying plugins default to independent copies so each agent gets
        // its own chat history (shared code, private data — R6). web-chat persists the
        // per-agent transcript (the conversation), so it is private-by-default.
        const privateByDefault = available.filter((p) => p === "web-chat");
        await guard(async () => {
          await cli.writeDefault({
            intervalMs: 30000,
            plugins: available,
            ...(privateByDefault.length > 0 ? { privatePlugins: privateByDefault } : {}),
            config: {},
          });
        }, undefined);
      } else {
        throw err;
      }
    }

    const created = await guard(async () => {
      await cli.createAgent(agentId);
      return true;
    }, false);
    if (!created) return "landing";

    const persona = (
      await ask(() =>
        input({
          message: "persona — the agent's system prompt (how it should behave; empty keeps the default)",
          default: "You are Krakey, an autonomous agent. Be concise and helpful.",
        }),
      )
    ).trim();

    // Point the new agent at the connection we just made, and set its persona
    // (an emptied-out persona keeps the plugin's default).
    await guard(async () => {
      const agentDef = await cli.readAgent(agentId);
      const config = { ...(agentDef.config ?? {}) };
      config["llm-core"] = {
        ...((config["llm-core"] as Record<string, unknown>) ?? {}),
        communicator: connName,
      };
      if (persona !== "") {
        config["persona"] = {
          ...((config["persona"] as Record<string, unknown>) ?? {}),
          text: persona,
        };
      }
      await cli.writeAgent(agentId, { ...agentDef, config });
    }, undefined);

    out("");
    out(
      success(
        "All set — run " + bold("npm start") + ' and talk to "' + agentId + '" in this terminal.',
      ),
    );
    return "landing";
  }

  // ── Loop ───────────────────────────────────────────────────────────────────
  const run = (page: Page): Promise<Page> => {
    switch (page) {
      case "landing":
        return landingPage();
      case "agents":
        return agentsPage();
      case "default":
        return defaultPage();
      case "providers":
        return providersPage();
      case "wizard":
        return wizardPage();
      case "quit":
        return Promise.resolve("quit");
    }
  };

  let page: Page = initialPage;
  while (page !== "quit") {
    try {
      page = await run(page);
    } catch (err) {
      if (err instanceof QuitSignal) {
        // Ctrl+C: at the main menu it quits; anywhere else it drops the
        // current action (unsaved edits abandoned) back to the main menu.
        if (page === "landing") {
          out("");
          return;
        }
        out(dim("(cancelled — nothing saved)"));
        page = "landing";
        continue;
      }
      throw err;
    }
  }
}
