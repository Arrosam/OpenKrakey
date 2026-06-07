/**
 * cli — the interactive shell. The ONLY module (besides bin.ts) that imports
 * `@inquirer/prompts`. Everything stateful-fs goes through the pure `Cli` core.
 *
 * Control flow: a `while` loop over a current-page name. Each page is a local
 * async function that performs prompts + cli ops and returns the NEXT page name
 * (or "quit"). A Ctrl+C / ExitPromptError anywhere is funnelled to Quit via a
 * private QuitSignal; expected CliErrors are printed and the loop continues;
 * anything else bubbles out.
 */
import { checkbox, confirm, input, select } from "@inquirer/prompts";

import type { AgentDefinition } from "../../../contracts/agent";
import type {
  CommunicatorDef,
  DefaultAgentSetting,
  LLMConfig,
} from "../../../shared/config";

import { CliError, type Cli } from "./index";
import { KRAKEY_LOGO } from "./logo";

export type InitialPage = "landing" | "agents" | "default" | "providers";

/** Internal page space: the entry pages plus "quit". */
type Page = InitialPage | "quit";

/** Raised when the user hits Ctrl+C (inquirer's ExitPromptError) — means Quit. */
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

const BACK = "← Back";
const CREATE_NEW = "➕ Create new";
const ADD = "➕ Add";
const DONE = "Done";

/** Reusable id validator for agent ids: non-empty, no spaces or slashes. */
function validateId(raw: string): true | string {
  const v = raw.trim();
  if (v.length === 0) return "id must not be empty";
  if (/[\s/\\]/.test(v)) return "id must not contain spaces or slashes";
  return true;
}

/** Parse a positive integer from free text; undefined if not a positive int. */
function parsePositiveInt(raw: string): number | undefined {
  const v = raw.trim();
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 ? n : undefined;
}

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
        out(err.message);
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
        { name: "Add key", value: "add" },
        { name: "Remove key", value: "remove" },
        { name: DONE, value: "done" },
      ];

      const action = await ask(() =>
        select({ message: "config", choices, loop: false }),
      );

      if (action === "done") return cfg;

      if (action === "add") {
        const key = (
          await ask(() =>
            input({
              message: "new key name",
              validate: (r) =>
                r.trim().length > 0 ? true : "key must not be empty",
            }),
          )
        ).trim();
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
            { name: `intervalMs: ${draft.intervalMs}`, value: "intervalMs" },
            {
              name: `plugins: [${draft.plugins.join(", ")}]`,
              value: "plugins",
            },
            {
              name: `privatePlugins: [${(draft.privatePlugins ?? []).join(", ")}]`,
              value: "privatePlugins",
            },
            {
              name: `config: ${Object.keys(draft.config ?? {}).length} key(s)`,
              value: "config",
            },
            { name: "Save & Back", value: "save" },
            { name: "Discard & Back", value: "discard" },
          ],
          loop: false,
        }),
      );

      if (field === "save") return true;
      if (field === "discard") return false;

      if (field === "intervalMs") {
        const raw = await ask(() =>
          input({
            message: "intervalMs (positive integer)",
            default: String(draft.intervalMs),
            validate: (r) =>
              parsePositiveInt(r) !== undefined
                ? true
                : "must be a positive integer",
          }),
        );
        const n = parsePositiveInt(raw);
        if (n !== undefined) draft.intervalMs = n;
        continue;
      }

      if (field === "plugins") {
        draft.plugins = await ask(() =>
          checkbox({
            message: "public plugins to load",
            choices: availablePlugins.map((p) => ({
              name: p,
              value: p,
              checked: draft.plugins.includes(p),
            })),
            loop: false,
          }),
        );
        continue;
      }

      if (field === "privatePlugins") {
        const picked = await ask(() =>
          checkbox({
            message: "private plugins (independent copies)",
            choices: availablePlugins.map((p) => ({
              name: p,
              value: p,
              checked: (draft.privatePlugins ?? []).includes(p),
            })),
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
      out(`Saved agent "${id}".`);
    }
  }

  // ── Pages ──────────────────────────────────────────────────────────────────
  async function landingPage(): Promise<Page> {
    out(KRAKEY_LOGO);
    return ask(() =>
      select<Page>({
        message: "OpenKrakey config",
        choices: [
          { name: "Agents", value: "agents" },
          { name: "Default setting", value: "default" },
          { name: "LLM providers", value: "providers" },
          { name: "Quit", value: "quit" },
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
        await ask(() => input({ message: "new agent id", validate: validateId }))
      ).trim();
      await guard(() => cli.createAgent(id), undefined);
      return "agents";
    }

    // Selected an existing agent id → detail.
    const action = await ask(() =>
      select<"edit" | "delete" | "back">({
        message: `Agent "${choice}"`,
        choices: [
          { name: "Edit", value: "edit" },
          { name: "Delete config", value: "delete" },
          { name: BACK, value: "back" },
        ],
        loop: false,
      }),
    );

    if (action === "edit") {
      await agentEditor(choice);
    } else if (action === "delete") {
      const yes = await ask(() =>
        confirm({
          message: `Delete config for "${choice}"? (data kept)`,
          default: false,
        }),
      );
      if (yes) {
        await guard(() => cli.removeAgent(choice), undefined);
        out(`Removed config for "${choice}".`);
      }
    }
    return "agents";
  }

  async function defaultPage(): Promise<Page> {
    let setting = await guard<DefaultAgentSetting | null>(
      () => cli.readDefault(),
      null,
    );
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
      out("Saved default setting.");
    }
    return "landing";
  }

  // ── Providers (LLM communicators) ──────────────────────────────────────────
  /** Edit one communicator def on `cfg` under `name`; returns true on Save. */
  async function communicatorEditor(
    cfg: LLMConfig,
    name: string,
    isNew: boolean,
  ): Promise<boolean> {
    const existing = cfg.communicators[name];
    const draft: CommunicatorDef = {
      provider: existing?.provider ?? "",
      model: existing?.model ?? "",
      baseURL: existing?.baseURL,
      apiKey: existing?.apiKey,
    };

    for (;;) {
      const maskedKey =
        draft.apiKey === undefined || draft.apiKey === "" ? "(unset)" : "***";
      const field = await ask(() =>
        select({
          message: isNew ? `New provider "${name}"` : `Provider "${name}"`,
          choices: [
            { name: `provider: ${draft.provider}`, value: "provider" },
            { name: `model: ${draft.model}`, value: "model" },
            { name: `baseURL: ${draft.baseURL ?? "(none)"}`, value: "baseURL" },
            { name: `apiKey: ${maskedKey}`, value: "apiKey" },
            { name: "Save", value: "save" },
            // Delete only applies to an EXISTING communicator, not a new one.
            ...(isNew ? [] : [{ name: "Delete", value: "delete" }]),
            { name: "Cancel", value: "cancel" },
          ],
          loop: false,
        }),
      );

      if (field === "cancel") return false;

      if (field === "save") {
        cfg.communicators[name] = {
          provider: draft.provider,
          model: draft.model,
          ...(draft.baseURL ? { baseURL: draft.baseURL } : {}),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        };
        return true;
      }

      if (field === "delete") {
        delete cfg.communicators[name];
        return true;
      }

      if (field === "provider") {
        draft.provider = (
          await ask(() =>
            input({ message: "provider id", default: draft.provider }),
          )
        ).trim();
      } else if (field === "model") {
        draft.model = (
          await ask(() => input({ message: "model", default: draft.model }))
        ).trim();
      } else if (field === "baseURL") {
        const v = (
          await ask(() =>
            input({
              message: "baseURL (blank for none)",
              default: draft.baseURL ?? "",
            }),
          )
        ).trim();
        draft.baseURL = v === "" ? undefined : v;
      } else {
        // apiKey — never pre-fill with the real value; blank keeps the current.
        const v = await ask(() =>
          input({ message: "apiKey (blank to keep current)" }),
        );
        if (v.trim() !== "") draft.apiKey = v;
      }
    }
  }

  async function providersPage(): Promise<Page> {
    const cfg = await guard<LLMConfig>(() => cli.readLLMConfig(), {
      communicators: {},
    });
    const names = Object.keys(cfg.communicators).sort();

    const choice = await ask(() =>
      select<string>({
        message: "LLM providers",
        choices: [
          ...names.map((n) => ({ name: n, value: n })),
          { name: ADD, value: "\0add" },
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
            message: "communicator name",
            validate: (r) => {
              const v = r.trim();
              if (v.length === 0) return "name must not be empty";
              if (cfg.communicators[v]) return "name already exists";
              return true;
            },
          }),
        )
      ).trim();
    } else {
      name = choice;
    }

    const changed = await communicatorEditor(cfg, name, isNew);
    if (changed) {
      await guard(() => cli.writeLLMConfig(cfg), undefined);
      out(`Saved providers.`);
    }
    return "providers";
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
      case "quit":
        return Promise.resolve("quit");
    }
  };

  let page: Page = initialPage;
  try {
    while (page !== "quit") {
      page = await run(page);
    }
  } catch (err) {
    if (err instanceof QuitSignal) {
      out("");
      return;
    }
    throw err;
  }
}
