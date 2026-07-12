import { test } from "node:test";
import assert from "node:assert/strict";
import type { ConfigField, ConfigSchema } from "../../contracts/plugin";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for every configured plugin's PURE-DATA `config-schema.ts`.
//
// Derived ONLY from:
//   * contracts/plugin  (the new ConfigField / ConfigSchema vocabulary)
//   * the spec handed to this test-writer (exact key set + type/option/showIf
//     expectations per plugin)
//
// We NEVER read the implementation. The `config-schema.ts` modules do not exist
// yet — this test is written first and goes green once they do. We import ONLY
// the pure-data schema modules (never a plugin's `index.ts`, which has runtime
// side effects). The contract requires each declaring module to import only the
// `ConfigField` type, so a config tool can read it WITHOUT executing the plugin.
//
// Static `import` is used (not a guarded dynamic import): a missing schema module
// is a hard, honest failure of the whole suite — exactly the red state we want
// before the modules are authored.
// ---------------------------------------------------------------------------

import { PERSONA_SCHEMA } from "../../public_plugin/persona/config-schema";
import { SYSTEM_PROMPT_SCHEMA } from "../../public_plugin/system-prompt/config-schema";
import { LLM_CORE_SCHEMA } from "../../public_plugin/llm-core/config-schema";
import { WEB_SCHEMA } from "../../public_plugin/web-chat/config-schema";
import { INSPECTOR_SCHEMA } from "../../public_plugin/inspector/config-schema";
import { KRAKEYCODE_SCHEMA } from "../../public_plugin/krakeycode/config-schema";
import { WEB_SEARCH_SCHEMA } from "../../public_plugin/web-search/config-schema";
import { BROWSER_SCHEMA } from "../../public_plugin/browser/config-schema";
import { RESTART_SCHEMA } from "../../public_plugin/restart/config-schema";

// ---------------------------------------------------------------------------
// The 9 allowed `type` values, straight from the contract.
// ---------------------------------------------------------------------------
const ALLOWED_TYPES = [
  "string",
  "text",
  "url",
  "secret",
  "number",
  "boolean",
  "enum",
  "multienum",
  "list",
] as const;

// ---------------------------------------------------------------------------
// Reusable structural validator — asserts a value is a contract-conformant
// ConfigSchema. `label` only colors the assertion messages.
// ---------------------------------------------------------------------------
function assertValidConfigSchema(schema: unknown, label: string): void {
  assert.ok(Array.isArray(schema), `${label}: schema must be an array`);
  assert.ok((schema as unknown[]).length > 0, `${label}: schema must be non-empty`);

  const seenKeys = new Set<string>();

  for (const [i, raw] of (schema as unknown[]).entries()) {
    const where = `${label}[${i}]`;
    assert.ok(
      raw !== null && typeof raw === "object",
      `${where}: each field must be an object`,
    );
    const field = raw as ConfigField;

    // key — non-empty string, unique within the schema.
    assert.equal(typeof field.key, "string", `${where}: key must be a string`);
    assert.ok(field.key.length > 0, `${where}: key must be non-empty`);
    assert.equal(
      seenKeys.has(field.key),
      false,
      `${where}: duplicate key '${field.key}' within ${label}`,
    );
    seenKeys.add(field.key);

    // label — string (a control needs a caption).
    assert.equal(
      typeof field.label,
      "string",
      `${where} (${field.key}): label must be a string`,
    );

    // type — one of the 9 allowed.
    assert.ok(
      (ALLOWED_TYPES as readonly string[]).includes(field.type),
      `${where} (${field.key}): type '${String(field.type)}' is not one of ${ALLOWED_TYPES.join("|")}`,
    );

    // enum / multienum must carry a non-empty, well-formed options array.
    if (field.type === "enum" || field.type === "multienum") {
      assert.ok(
        Array.isArray(field.options),
        `${where} (${field.key}): ${field.type} field must have an options array`,
      );
      assert.ok(
        (field.options as unknown[]).length > 0,
        `${where} (${field.key}): ${field.type} options must be non-empty`,
      );
      for (const [j, opt] of (field.options as unknown[]).entries()) {
        const ow = `${where} (${field.key}).options[${j}]`;
        assert.ok(opt !== null && typeof opt === "object", `${ow}: option must be an object`);
        const o = opt as { value: unknown; label: unknown };
        assert.ok(
          typeof o.value === "string" || typeof o.value === "number",
          `${ow}: option value must be a string or number`,
        );
        assert.equal(typeof o.label, "string", `${ow}: option label must be a string`);
      }
    }

    // showIf, when present, must have a string `key` + an `equals` property.
    if (field.showIf !== undefined) {
      assert.ok(
        field.showIf !== null && typeof field.showIf === "object",
        `${where} (${field.key}): showIf must be an object`,
      );
      assert.equal(
        typeof field.showIf.key,
        "string",
        `${where} (${field.key}): showIf.key must be a string`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(field.showIf, "equals"),
        `${where} (${field.key}): showIf must declare an 'equals' value`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers for the per-plugin assertions.
// ---------------------------------------------------------------------------

/** The set of keys a schema declares (order-independent). */
function keySet(schema: ConfigSchema): Set<string> {
  return new Set(schema.map((f) => f.key));
}

/** Find a field by key (asserting it exists). */
function field(schema: ConfigSchema, key: string, label: string): ConfigField {
  const f = schema.find((x) => x.key === key);
  assert.ok(f, `${label}: expected a field with key '${key}'`);
  return f as ConfigField;
}

/** Assert a schema covers EXACTLY the expected key set (order-independent). */
function assertKeysExactly(schema: ConfigSchema, expected: string[], label: string): void {
  assert.deepEqual(
    [...keySet(schema)].sort(),
    [...expected].sort(),
    `${label}: declared keys must match the contract-pinned set exactly`,
  );
}

// ===========================================================================
// 1. persona — keys: text, priority
// ===========================================================================
test("persona: schema is contract-valid and covers exactly { text, priority }", () => {
  assertValidConfigSchema(PERSONA_SCHEMA, "PERSONA_SCHEMA");
  assertKeysExactly(PERSONA_SCHEMA as ConfigSchema, ["text", "priority"], "PERSONA_SCHEMA");
});

test("persona: priority is a number field", () => {
  const f = field(PERSONA_SCHEMA as ConfigSchema, "priority", "PERSONA_SCHEMA");
  assert.equal(f.type, "number", "persona.priority must be type 'number'");
});

// ===========================================================================
// 2. system-prompt — keys: text, priority
// ===========================================================================
test("system-prompt: schema is contract-valid and covers exactly { text, priority }", () => {
  assertValidConfigSchema(SYSTEM_PROMPT_SCHEMA, "SYSTEM_PROMPT_SCHEMA");
  assertKeysExactly(
    SYSTEM_PROMPT_SCHEMA as ConfigSchema,
    ["text", "priority"],
    "SYSTEM_PROMPT_SCHEMA",
  );
});

test("system-prompt: priority is a number field", () => {
  const f = field(SYSTEM_PROMPT_SCHEMA as ConfigSchema, "priority", "SYSTEM_PROMPT_SCHEMA");
  assert.equal(f.type, "number", "system-prompt.priority must be type 'number'");
});

// ===========================================================================
// 3. llm-core — keys: communicator, temperature, maxTokens + the context.full knobs
// ===========================================================================
test("llm-core: schema is contract-valid and covers exactly its keys", () => {
  assertValidConfigSchema(LLM_CORE_SCHEMA, "LLM_CORE_SCHEMA");
  assertKeysExactly(
    LLM_CORE_SCHEMA as ConfigSchema,
    ["communicator", "temperature", "maxTokens", "contextLimitTokens", "safetyTokens", "charsPerToken", "maxReduceRounds", "retryOnContextError", "contextErrorPatterns"],
    "LLM_CORE_SCHEMA",
  );
});

// ===========================================================================
// 4. web-chat — keys: port, host, token, guidance, guidancePriority,
//                conversationMaxTurns, conversationMaxChars
// ===========================================================================
test("web-chat: schema is contract-valid and covers exactly its seven keys", () => {
  assertValidConfigSchema(WEB_SCHEMA, "WEB_SCHEMA");
  assertKeysExactly(
    WEB_SCHEMA as ConfigSchema,
    [
      "port",
      "host",
      "token",
      "guidance",
      "guidancePriority",
      "conversationMaxTurns",
      "conversationMaxChars",
    ],
    "WEB_SCHEMA",
  );
});

test("web-chat: token is a secret field (masked in UIs)", () => {
  const f = field(WEB_SCHEMA as ConfigSchema, "token", "WEB_SCHEMA");
  assert.equal(f.type, "secret", "web-chat.token must be type 'secret'");
});

// ===========================================================================
// 5. inspector — keys: port, host, token, bufferSize, maxRecordBytes,
//    persist, maxPersistedEntries, retentionMs (the Logs-view persistence settings)
// ===========================================================================
test("inspector: schema is contract-valid and covers exactly its eight keys", () => {
  assertValidConfigSchema(INSPECTOR_SCHEMA, "INSPECTOR_SCHEMA");
  assertKeysExactly(
    INSPECTOR_SCHEMA as ConfigSchema,
    ["port", "host", "token", "bufferSize", "maxRecordBytes", "persist", "maxPersistedEntries", "retentionMs"],
    "INSPECTOR_SCHEMA",
  );
});

test("inspector: token is a secret field (masked in UIs)", () => {
  const f = field(INSPECTOR_SCHEMA as ConfigSchema, "token", "INSPECTOR_SCHEMA");
  assert.equal(f.type, "secret", "inspector.token must be type 'secret'");
});

// ===========================================================================
// 6. krakeycode — 16 keys + targeted type/option/showIf assertions
//    (+1 vs. the pre-F2 census: maxFailureNotices — the persistent-failure
//    ledger bound, a number field like the other numeric knobs)
// ===========================================================================
test("krakeycode: schema is contract-valid and covers exactly its sixteen keys", () => {
  assertValidConfigSchema(KRAKEYCODE_SCHEMA, "KRAKEYCODE_SCHEMA");
  assertKeysExactly(
    KRAKEYCODE_SCHEMA as ConfigSchema,
    [
      "mode",
      "root",
      "allowWrite",
      "allowCommands",
      "commandAllowlist",
      "commandTimeoutMs",
      "maxReadBytes",
      "maxOutputBytes",
      "maxResults",
      "maxResultChars",
      "maxEntries",
      "maxResultsTotalChars",
      "maxFailureNotices",
      "guidance",
      "guidancePriority",
      "resultsPriority",
    ],
    "KRAKEYCODE_SCHEMA",
  );
});

test("krakeycode: maxFailureNotices is a number field", () => {
  const f = field(KRAKEYCODE_SCHEMA as ConfigSchema, "maxFailureNotices", "KRAKEYCODE_SCHEMA");
  assert.equal(f.type, "number", "krakeycode.maxFailureNotices must be type 'number'");
});

test("krakeycode: mode is an enum whose option values are exactly ['local','sandbox']", () => {
  const f = field(KRAKEYCODE_SCHEMA as ConfigSchema, "mode", "KRAKEYCODE_SCHEMA");
  assert.equal(f.type, "enum", "krakeycode.mode must be type 'enum'");
  assert.ok(Array.isArray(f.options), "krakeycode.mode must declare options");
  assert.deepEqual(
    (f.options as Array<{ value: string | number }>).map((o) => o.value).sort(),
    ["local", "sandbox"],
    "krakeycode.mode option values must be exactly ['local','sandbox']",
  );
});

test("krakeycode: allowWrite and allowCommands are boolean fields", () => {
  assert.equal(
    field(KRAKEYCODE_SCHEMA as ConfigSchema, "allowWrite", "KRAKEYCODE_SCHEMA").type,
    "boolean",
    "krakeycode.allowWrite must be type 'boolean'",
  );
  assert.equal(
    field(KRAKEYCODE_SCHEMA as ConfigSchema, "allowCommands", "KRAKEYCODE_SCHEMA").type,
    "boolean",
    "krakeycode.allowCommands must be type 'boolean'",
  );
});

test("krakeycode: commandAllowlist is a list field", () => {
  const f = field(KRAKEYCODE_SCHEMA as ConfigSchema, "commandAllowlist", "KRAKEYCODE_SCHEMA");
  assert.equal(f.type, "list", "krakeycode.commandAllowlist must be type 'list'");
});

test("krakeycode: root has showIf { key:'mode', equals:'sandbox' }", () => {
  const f = field(KRAKEYCODE_SCHEMA as ConfigSchema, "root", "KRAKEYCODE_SCHEMA");
  assert.ok(f.showIf, "krakeycode.root must declare a showIf");
  assert.equal(f.showIf!.key, "mode", "krakeycode.root.showIf.key must be 'mode'");
  assert.equal(f.showIf!.equals, "sandbox", "krakeycode.root.showIf.equals must be 'sandbox'");
});

// ===========================================================================
// 7. web-search — 17 keys + targeted type/option assertions
//    (+1 vs. the pre-F2 census: maxFailureNotices — the persistent-failure
//    ledger bound, a number field like the other numeric knobs)
// ===========================================================================
test("web-search: schema is contract-valid and covers exactly its seventeen keys", () => {
  assertValidConfigSchema(WEB_SEARCH_SCHEMA, "WEB_SEARCH_SCHEMA");
  assertKeysExactly(
    WEB_SEARCH_SCHEMA as ConfigSchema,
    [
      "instanceUrl",
      "localUrl",
      "usePublicFallback",
      "useDuckDuckGoFallback",
      "publicInstances",
      "safesearch",
      "language",
      "categories",
      "timeoutMs",
      "maxResults",
      "maxSnippetChars",
      "maxResultChars",
      "maxResultsTotalChars",
      "maxFailureNotices",
      "guidance",
      "guidancePriority",
      "resultsPriority",
    ],
    "WEB_SEARCH_SCHEMA",
  );
});

test("web-search: maxFailureNotices is a number field", () => {
  const f = field(WEB_SEARCH_SCHEMA as ConfigSchema, "maxFailureNotices", "WEB_SEARCH_SCHEMA");
  assert.equal(f.type, "number", "web-search.maxFailureNotices must be type 'number'");
});

test("web-search: safesearch is an enum whose option values are exactly [0,1,2] (numbers)", () => {
  const f = field(WEB_SEARCH_SCHEMA as ConfigSchema, "safesearch", "WEB_SEARCH_SCHEMA");
  assert.equal(f.type, "enum", "web-search.safesearch must be type 'enum'");
  assert.ok(Array.isArray(f.options), "web-search.safesearch must declare options");
  const values = (f.options as Array<{ value: string | number }>).map((o) => o.value);
  // Numbers, NOT strings — assert both the values and that each is a number.
  for (const v of values) {
    assert.equal(typeof v, "number", `web-search.safesearch option value ${JSON.stringify(v)} must be a number`);
  }
  assert.deepEqual(
    [...values].sort(),
    [0, 1, 2],
    "web-search.safesearch option values must be exactly [0,1,2]",
  );
});

test("web-search: usePublicFallback is a boolean field", () => {
  const f = field(WEB_SEARCH_SCHEMA as ConfigSchema, "usePublicFallback", "WEB_SEARCH_SCHEMA");
  assert.equal(f.type, "boolean", "web-search.usePublicFallback must be type 'boolean'");
});

test("web-search: useDuckDuckGoFallback is a boolean field", () => {
  const f = field(WEB_SEARCH_SCHEMA as ConfigSchema, "useDuckDuckGoFallback", "WEB_SEARCH_SCHEMA");
  assert.equal(f.type, "boolean", "web-search.useDuckDuckGoFallback must be type 'boolean'");
});

test("web-search: publicInstances is a list field", () => {
  const f = field(WEB_SEARCH_SCHEMA as ConfigSchema, "publicInstances", "WEB_SEARCH_SCHEMA");
  assert.equal(f.type, "list", "web-search.publicInstances must be type 'list'");
});

test("web-search: instanceUrl and localUrl are url fields", () => {
  assert.equal(
    field(WEB_SEARCH_SCHEMA as ConfigSchema, "instanceUrl", "WEB_SEARCH_SCHEMA").type,
    "url",
    "web-search.instanceUrl must be type 'url'",
  );
  assert.equal(
    field(WEB_SEARCH_SCHEMA as ConfigSchema, "localUrl", "WEB_SEARCH_SCHEMA").type,
    "url",
    "web-search.localUrl must be type 'url'",
  );
});

// ===========================================================================
// 8. browser — 15 keys + targeted type/option assertions
//    (+1 vs. the pre-F2 census: maxFailureNotices — the persistent-failure
//    ledger bound, a number field like the other numeric knobs)
// ===========================================================================
test("browser: schema is contract-valid and covers exactly its fifteen keys", () => {
  assertValidConfigSchema(BROWSER_SCHEMA, "BROWSER_SCHEMA");
  assertKeysExactly(
    BROWSER_SCHEMA as ConfigSchema,
    [
      "headless",
      "headlessMode",
      "chromePath",
      "remoteDebugPort",
      "navigationTimeoutMs",
      "commandTimeoutMs",
      "maxTextChars",
      "screenshotDir",
      "guidance",
      "guidancePriority",
      "resultsPriority",
      "maxResults",
      "maxResultChars",
      "maxResultsTotalChars",
      "maxFailureNotices",
    ],
    "BROWSER_SCHEMA",
  );
});

test("browser: headless is a boolean field", () => {
  const f = field(BROWSER_SCHEMA as ConfigSchema, "headless", "BROWSER_SCHEMA");
  assert.equal(f.type, "boolean", "browser.headless must be type 'boolean'");
});

test("browser: maxFailureNotices is a number field", () => {
  const f = field(BROWSER_SCHEMA as ConfigSchema, "maxFailureNotices", "BROWSER_SCHEMA");
  assert.equal(f.type, "number", "browser.maxFailureNotices must be type 'number'");
});

test("browser: headlessMode is an enum whose option values are exactly ['new','old','off'] (default 'new')", () => {
  const f = field(BROWSER_SCHEMA as ConfigSchema, "headlessMode", "BROWSER_SCHEMA");
  assert.equal(f.type, "enum", "browser.headlessMode must be type 'enum'");
  assert.ok(Array.isArray(f.options), "browser.headlessMode must declare options");
  assert.deepEqual(
    (f.options as Array<{ value: string | number }>).map((o) => o.value).sort(),
    ["new", "off", "old"],
    "browser.headlessMode option values must be exactly ['new','old','off']",
  );
  assert.equal(f.default, "new", "browser.headlessMode default must be 'new'");
});

// ===========================================================================
// 9. restart — 5 keys + targeted type assertions
//    (+1 vs. the pre-F1 census: completedNoticeMaxAgeMs — the age window a
//    persisted restart marker stays "fresh", a number field like delayMs.)
// ===========================================================================
test("restart: schema is contract-valid and covers exactly its five keys", () => {
  assertValidConfigSchema(RESTART_SCHEMA, "RESTART_SCHEMA");
  assertKeysExactly(
    RESTART_SCHEMA as ConfigSchema,
    [
      "delayMs",
      "dryRun",
      "guidance",
      "guidancePriority",
      "completedNoticeMaxAgeMs",
    ],
    "RESTART_SCHEMA",
  );
});

test("restart: completedNoticeMaxAgeMs is a number field defaulting to 300000", () => {
  const f = field(RESTART_SCHEMA as ConfigSchema, "completedNoticeMaxAgeMs", "RESTART_SCHEMA");
  assert.equal(f.type, "number", "restart.completedNoticeMaxAgeMs must be type 'number'");
  assert.equal(f.default, 300000, "restart.completedNoticeMaxAgeMs default must be 300000 (5 min)");
});

test("restart: dryRun is a boolean field and delayMs is a number field", () => {
  assert.equal(
    field(RESTART_SCHEMA as ConfigSchema, "dryRun", "RESTART_SCHEMA").type,
    "boolean",
    "restart.dryRun must be type 'boolean'",
  );
  assert.equal(
    field(RESTART_SCHEMA as ConfigSchema, "delayMs", "RESTART_SCHEMA").type,
    "number",
    "restart.delayMs must be type 'number'",
  );
});
