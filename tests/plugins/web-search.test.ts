import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventSystem } from "../../packages/event-system/src";
import { Actions, Events } from "../../shared/actions";
import type { ContextBlock } from "../../contracts/context";
import type { Message, ToolDef } from "../../contracts/llm";

// ---------------------------------------------------------------------------
// BLACK-BOX edge tests for the `web-search` plugin — a web-search tool that
// waterfalls over SearXNG endpoints and falls back to DuckDuckGo Lite.
//
// Derived ONLY from the contract/spec (impl not read — it does not exist yet):
//   default export = PluginFactory; manifest = { id:"web-search",
//                                                 version:"0.1.0",
//                                                 requires:["llm.register_tool"] }
//   config slice (all optional w/ defaults):
//     instanceUrl null; localUrl "http://localhost:8080";
//     publicInstances [searx.be, search.inetol.net, paulgo.io, searx.tiekoetter.com];
//     usePublicFallback true; useDuckDuckGoFallback true; language "auto";
//     categories "general"; safesearch 0; timeoutMs 10000; maxResults 5;
//     maxSnippetChars 400; maxResultChars 1200; maxResultsTotalChars 12000;
//     guidance null; guidancePriority 6000; resultsPriority 3500.
//   setup: TWO blocks (web-search.guidance @system/6000,
//          web-search.results @messages/3500) + ONE action/tool web-search.search
//          declared to llm.register_tool.
//
// web-search has no fs and reaches the network via globalThis.fetch — every
// network test stubs fetch with a fake Response-like object and restores it
// afterwards.
// ---------------------------------------------------------------------------

const ID = "web-search";
const GUIDANCE_BLOCK = "web-search.guidance";
const RESULTS_BLOCK = "web-search.results";
const SEARCH = "web-search.search";

const DEFAULT_LOCAL = "http://localhost:8080";
const DEFAULT_PUBLIC = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://paulgo.io",
  "https://searx.tiekoetter.com",
];

// The default public-instance pool is now EMPTY (public SearXNG JSON is unreliable;
// the keyless DuckDuckGo fallback covers the default case). Tests that exercise the
// SearXNG endpoint WATERFALL must therefore supply an explicit public pool — and
// turn the DDG fallback OFF so the 2nd attempt is deterministically a public SearXNG.
const SEARX_CFG = { publicInstances: DEFAULT_PUBLIC, useDuckDuckGoFallback: false };

// ---- tolerant dynamic import: a missing module fails each test cleanly ----
const mod: any = await import("../../public_plugin/web-search/index.ts").then(
  (m) => m,
  () => null,
);
function plugin(): any {
  assert.ok(mod, "web-search module not implemented yet (import failed)");
  assert.equal(typeof mod?.default, "function", "default export must be a PluginFactory");
  return mod.default();
}

// ---- tolerant dynamic import of the pure-helper module (optional) ---------
const helpers: any = await import("../../public_plugin/web-search/search.ts").then(
  (m) => m,
  () => null,
);

// ---- fake PluginContext over a REAL event system --------------------------
// A real recording "llm.register_tool" action records each declared ToolDef.
// Blocks are backed by a Map. web-search does no fs, so dataDir can be any string.
function makeCtx(config: unknown) {
  const store = new Map<string, ContextBlock>();
  const sys = createEventSystem();
  const tools: ToolDef[] = [];
  sys.actions.register("llm.register_tool", async (def: unknown) => {
    tools.push(def as ToolDef);
    return true;
  });
  const ctx: any = {
    agentId: "agent-test",
    events: sys.events,
    actions: sys.actions,
    config,
    dataDir: "/tmp/web-search-test-datadir",
    llm: { get: () => undefined, has: () => false, list: () => [], withCapability: () => [] },
    setBlock: (b: ContextBlock) => {
      store.set(b.id, b);
    },
    getBlock: (id: string) => store.get(id),
    removeBlock: (id: string) => store.delete(id),
    listBlocks: () => [...store.values()].map((b) => ({ id: b.id, priority: b.priority })),
    log: { info() {}, warn() {}, error() {} },
    print() {},
  };
  return { ctx, store, sys, tools };
}

async function setup(config: unknown) {
  const p = plugin();
  const h = makeCtx(config);
  await p.setup(h.ctx);
  return { p, ...h };
}

function guidanceBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(GUIDANCE_BLOCK);
  assert.ok(b, "setup must register a block under id 'web-search.guidance'");
  return b as ContextBlock;
}
function resultsBlock(store: Map<string, ContextBlock>): ContextBlock {
  const b = store.get(RESULTS_BLOCK);
  assert.ok(b, "setup must register a block under id 'web-search.results'");
  return b as ContextBlock;
}
const renderStr = async (b: ContextBlock): Promise<string> => (await b.render()) as string;
const renderMsgs = async (b: ContextBlock): Promise<Message[]> => (await b.render()) as Message[];

// ---- fetch stubbing helpers ----------------------------------------------
// fetchScript drives a per-endpoint sequence. Each call to the stub consumes the
// next "step": a step is a function (url, init) => Response-like | throws, OR a
// shorthand object. The stub records every requested url into `urls`.
type Step = (url: string, init?: any) => any;

function makeResponse(opts: { ok?: boolean; status?: number; json?: () => any; text?: () => any }): any {
  const status = opts.status ?? (opts.ok === false ? 500 : 200);
  return {
    ok: opts.ok ?? (status >= 200 && status < 300),
    status,
    json: opts.json ?? (async () => ({})),
    text: opts.text ?? (async () => ""),
  };
}

// Install a fetch stub that returns `makeResponse(stepFor(url))` based on a
// url->Step map plus a default. Records urls. Returns { urls, restore }.
function installFetch(handler: Step) {
  const urls: string[] = [];
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (url: any, init?: any) => {
    const u = String(url);
    urls.push(u);
    return handler(u, init);
  };
  const restore = () => {
    (globalThis as any).fetch = original;
  };
  return { urls, restore };
}

// A success body in SearXNG's native JSON shape (results: [{title,url,content}]).
function searxBody(results: Array<{ title?: string; url?: string; content?: string }>) {
  return { results };
}

// The base origin of a url (scheme://host[:port]) — to match an endpoint to its
// recorded request regardless of the /search?... query suffix.
function originOf(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return u;
  }
}

// A deterministic DuckDuckGo Lite HTML body containing two results.
const DDG_HTML =
  `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdownload&amp;rut=x1" class='result-link'>Node.js Downloads &amp; Docs</a> <td class='result-snippet'>Node.js&#39;s official site.</td> <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&amp;rut=x2" class='result-link'>Example <b>Page</b></a> <td class='result-snippet'>An <b>example</b> snippet.</td>`;

// ===========================================================================
// 1. manifest / factory
// ===========================================================================

test("manifest/factory: default export is a function (PluginFactory)", () => {
  assert.equal(typeof mod?.default, "function", "web-search default export must be a function");
});

test("manifest: id 'web-search' and version '0.1.0'", () => {
  const p = plugin();
  assert.equal(p.manifest.id, ID);
  assert.equal(p.manifest.version, "0.1.0");
});

test("manifest: requires includes 'llm.register_tool'", () => {
  const p = plugin();
  assert.ok(Array.isArray(p.manifest.requires), "requires must be an array");
  assert.ok(
    p.manifest.requires.includes("llm.register_tool"),
    "requires must include llm.register_tool",
  );
});

// ===========================================================================
// 2. setup — context blocks
// ===========================================================================

test("guidance block: system-target at default priority 6000, id 'web-search.guidance'", async () => {
  const { store } = await setup({});
  const b = guidanceBlock(store);
  assert.equal(b.id, GUIDANCE_BLOCK);
  assert.notEqual((b as any).target, "messages", "guidance must target the system prompt");
  assert.equal(b.priority, 6000);
  assert.equal(typeof (await renderStr(b)), "string", "system block renders a string");
});

test("guidance block: guidancePriority overrides the default", async () => {
  const { store } = await setup({ guidancePriority: 12345 });
  assert.equal(guidanceBlock(store).priority, 12345);
});

test("guidance text: default mentions the web-search.search tool", async () => {
  const { store } = await setup({});
  const text = await renderStr(guidanceBlock(store));
  assert.match(text, /web-search\.search/, "default guidance must name the search tool");
});

test("guidance text: cfg.guidance overrides verbatim", async () => {
  const { store } = await setup({ guidance: "CUSTOM WEB-SEARCH GUIDANCE" });
  assert.equal(await renderStr(guidanceBlock(store)), "CUSTOM WEB-SEARCH GUIDANCE");
});

test("results block: messages-target at default priority 3500, renders [] initially", async () => {
  const { store } = await setup({});
  const b = resultsBlock(store);
  assert.equal(b.id, RESULTS_BLOCK);
  assert.equal((b as any).target, "messages", "results must target the messages array");
  assert.equal(b.priority, 3500);
  const msgs = await renderMsgs(b);
  assert.ok(Array.isArray(msgs), "messages block renders an array");
  assert.deepEqual(msgs, [], "empty before any result is recorded");
});

test("results block: resultsPriority overrides the default", async () => {
  const { store } = await setup({ resultsPriority: 777 });
  assert.equal(resultsBlock(store).priority, 777);
});

// ===========================================================================
// 3. setup — the single ToolDef
// ===========================================================================

test("setup: registers the web-search.search action on the actionbus", async () => {
  const { sys } = await setup({});
  assert.ok(sys.actions.list().includes(SEARCH), "actions.list() must include web-search.search");
});

test("setup: declares exactly ONE ToolDef to llm.register_tool, named web-search.search", async () => {
  const { tools } = await setup({});
  assert.equal(tools.length, 1, "exactly one ToolDef declared");
  assert.equal(tools[0].name, SEARCH);
});

test("ToolDef: description is a non-empty string mentioning the next-frame 'web-search' delivery", async () => {
  const { tools } = await setup({});
  const desc = String(tools[0].description ?? "");
  assert.ok(desc.length > 0, "description must be non-empty");
  assert.match(desc, /web-search/, "description must mention the web-search tag");
});

test("ToolDef: parameters schema has query+pageno properties and required ['query']", async () => {
  const { tools } = await setup({});
  const params = tools[0].parameters as any;
  assert.equal(typeof params, "object", "parameters is an object");
  assert.ok(params !== null, "parameters is non-null");
  assert.ok(params.properties && typeof params.properties === "object", "has properties");
  assert.ok(params.properties.query, "declares a 'query' property");
  assert.ok(params.properties.pageno, "declares a 'pageno' property");
  assert.ok(Array.isArray(params.required), "required is an array");
  assert.ok(params.required.includes("query"), "required includes 'query'");
  assert.ok(!params.required.includes("pageno"), "pageno is NOT required");
});

// ===========================================================================
// 4. query validation — throws BEFORE any fetch (stub records zero calls)
// ===========================================================================

for (const bad of [
  { label: "missing query", params: {} },
  { label: "empty string", params: { query: "" } },
  { label: "whitespace-only", params: { query: "   \t\n " } },
  { label: "non-string query (number)", params: { query: 42 } },
  { label: "null query", params: { query: null } },
]) {
  test(`query validation: ${bad.label} rejects and never calls fetch`, async () => {
    const { sys } = await setup({});
    const { urls, restore } = installFetch(() => makeResponse({ ok: true }));
    try {
      await assert.rejects(
        sys.actions.invoke(SEARCH, bad.params),
        `${bad.label} must reject before any network call`,
      );
      assert.equal(urls.length, 0, "fetch must NOT be called for an invalid query");
    } finally {
      restore();
    }
  });
}

// ===========================================================================
// 5. waterfall happy path
// ===========================================================================

test("search (happy): 200 + results -> {endpoint,query,results} normalized to {title,url,snippet}", async () => {
  const { sys } = await setup({});
  const { urls, restore } = installFetch((u) =>
    makeResponse({
      ok: true,
      json: async () =>
        searxBody([
          { title: "T1", url: "https://a.example/1", content: "snippet one" },
          { title: "T2", url: "https://a.example/2", content: "snippet two" },
        ]),
    }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "hello world" });
    assert.equal(res.query, "hello world", "echoes the query");
    assert.equal(typeof res.endpoint, "string", "names the winning endpoint");
    assert.ok(Array.isArray(res.results), "results is an array");
    assert.equal(res.results.length, 2);
    assert.deepEqual(res.results[0], {
      title: "T1",
      url: "https://a.example/1",
      snippet: "snippet one",
    });
    // First endpoint tried is the default local one.
    assert.equal(originOf(urls[0]), DEFAULT_LOCAL, "first endpoint is the default localUrl");
  } finally {
    restore();
  }
});

test("search (happy): results length is capped to maxResults", async () => {
  const { sys } = await setup({ maxResults: 2 });
  const many = Array.from({ length: 5 }, (_, i) => ({
    title: `T${i}`,
    url: `https://a.example/${i}`,
    content: `c${i}`,
  }));
  const { restore } = installFetch(() =>
    makeResponse({ ok: true, json: async () => searxBody(many) }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results.length, 2, "results capped at maxResults");
  } finally {
    restore();
  }
});

test("search (happy): a snippet longer than maxSnippetChars is truncated with a trailing ellipsis", async () => {
  const cap = 20;
  const long = "x".repeat(200);
  const { sys } = await setup({ maxSnippetChars: cap });
  const { restore } = installFetch(() =>
    makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "T", url: "https://a.example/1", content: long }]),
    }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    const snip = String(res.results[0].snippet);
    assert.ok(snip.length <= cap + 1, `snippet (${snip.length}) must be ~<= cap (${cap}) + ellipsis`);
    assert.ok(snip.length < long.length, "snippet shorter than the source content");
    assert.match(snip, /…$/, "truncated snippet ends with an ellipsis");
  } finally {
    restore();
  }
});

test("search (happy): a short snippet is NOT truncated (no trailing ellipsis)", async () => {
  const { sys } = await setup({ maxSnippetChars: 400 });
  const { restore } = installFetch(() =>
    makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "T", url: "https://a.example/1", content: "short" }]),
    }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].snippet, "short", "short snippet passes through unchanged");
  } finally {
    restore();
  }
});

test("search (url): the request url carries format=json and the configured params", async () => {
  const { sys } = await setup({ language: "en", categories: "news", safesearch: 2 });
  const { urls, restore } = installFetch(() =>
    makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "T", url: "https://a.example/1", content: "c" }]),
    }),
  );
  try {
    await sys.actions.invoke(SEARCH, { query: "hello & friends" });
    const u = urls[0];
    assert.match(u, /\/search\?/, "hits the /search endpoint");
    assert.match(u, /format=json/, "requests JSON format");
    assert.match(u, /language=en/, "carries the configured language");
    assert.match(u, /categories=news/, "carries the configured categories");
    assert.match(u, /safesearch=2/, "carries the configured safesearch level");
    // The query is URL-encoded (a raw space/& must not appear unescaped in the q param).
    assert.ok(!/q=hello & friends/.test(u), "query value must be URL-encoded");
  } finally {
    restore();
  }
});

test("search (pageno): a valid pageno is forwarded in the url", async () => {
  const { sys } = await setup({});
  const { urls, restore } = installFetch(() =>
    makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "T", url: "https://a.example/1", content: "c" }]),
    }),
  );
  try {
    await sys.actions.invoke(SEARCH, { query: "q", pageno: 3 });
    assert.match(urls[0], /pageno=3/, "pageno forwarded into the url");
  } finally {
    restore();
  }
});

// ===========================================================================
// 6. fallthrough cases — first endpoint BAD, second GOOD -> second used
// ===========================================================================

// All fallthrough tests use the default endpoint list: [localUrl, ...publicInstances].
// The first endpoint (localUrl) fails in the way under test; the second
// (publicInstances[0]) returns a good body. We assert the second endpoint won.

function firstBadSecondGood(firstStep: Step) {
  let n = 0;
  return installFetch((u, init) => {
    n++;
    if (n === 1) return firstStep(u, init);
    return makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "OK", url: "https://b.example/1", content: "good" }]),
    });
  });
}

test("fallthrough: HTTP 500 on the first endpoint -> second endpoint wins", async () => {
  const { sys } = await setup(SEARX_CFG);
  const { urls, restore } = firstBadSecondGood(() => makeResponse({ ok: false, status: 500 }));
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].title, "OK", "result came from the second endpoint");
    assert.equal(originOf(urls[0]), DEFAULT_LOCAL, "first attempt was localUrl");
    assert.equal(originOf(urls[1]), DEFAULT_PUBLIC[0], "fell through to the first public instance");
  } finally {
    restore();
  }
});

test("fallthrough: fetch THROWS on the first endpoint -> second endpoint wins", async () => {
  const { sys } = await setup(SEARX_CFG);
  const { urls, restore } = firstBadSecondGood(() => {
    throw new Error("ECONNREFUSED");
  });
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].title, "OK");
    assert.equal(originOf(urls[1]), DEFAULT_PUBLIC[0], "second endpoint used after a network throw");
  } finally {
    restore();
  }
});

test("fallthrough: non-JSON (json() throws) on the first endpoint -> second endpoint wins", async () => {
  const { sys } = await setup(SEARX_CFG);
  const { urls, restore } = firstBadSecondGood(() =>
    makeResponse({
      ok: true,
      json: async () => {
        throw new Error("bad json");
      },
    }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].title, "OK");
    assert.equal(originOf(urls[1]), DEFAULT_PUBLIC[0], "second endpoint used after a JSON parse error");
  } finally {
    restore();
  }
});

test("fallthrough: json without a results array on the first endpoint -> second endpoint wins", async () => {
  const { sys } = await setup(SEARX_CFG);
  const { urls, restore } = firstBadSecondGood(() =>
    makeResponse({ ok: true, json: async () => ({ something: "else" }) }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].title, "OK");
    assert.equal(originOf(urls[1]), DEFAULT_PUBLIC[0], "second endpoint used when results is missing");
  } finally {
    restore();
  }
});

test("fallthrough: an EMPTY results array on the first endpoint -> second endpoint wins", async () => {
  const { sys } = await setup(SEARX_CFG);
  const { urls, restore } = firstBadSecondGood(() =>
    makeResponse({ ok: true, json: async () => searxBody([]) }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].title, "OK");
    assert.equal(originOf(urls[1]), DEFAULT_PUBLIC[0], "second endpoint used when results is empty");
  } finally {
    restore();
  }
});

// ===========================================================================
// 7. DuckDuckGo Lite fallback in the waterfall
// ===========================================================================

// When every SearXNG endpoint fails AND no instanceUrl is pinned, the waterfall
// reaches DuckDuckGo Lite. The stub serves DDG_HTML for any duckduckgo.com url
// and fails every SearXNG endpoint (non-JSON). Assert the parsed DDG results win.
test("ddg fallback: all SearXNG endpoints fail -> DuckDuckGo Lite is queried and its results returned", async () => {
  const { sys } = await setup({});
  const { urls, restore } = installFetch((u) => {
    if (u.includes("duckduckgo.com")) {
      return makeResponse({ ok: true, text: async () => DDG_HTML });
    }
    // Every SearXNG endpoint returns non-JSON (json() throws).
    return makeResponse({
      ok: true,
      json: async () => {
        throw new Error("not json");
      },
    });
  });
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "node downloads" });
    assert.ok(Array.isArray(res.results), "results is an array");
    assert.equal(res.results.length, 2, "two DDG results parsed");
    assert.deepEqual(res.results[0], {
      title: "Node.js Downloads & Docs",
      url: "https://nodejs.org/download",
      snippet: "Node.js's official site.",
    });
    // The winning endpoint url (a request that was actually issued) is DuckDuckGo.
    assert.ok(
      urls.some((u) => u.includes("duckduckgo.com")),
      "the waterfall must reach a duckduckgo.com url",
    );
    // DDG was tried only AFTER the SearXNG endpoints.
    assert.equal(originOf(urls[0]), DEFAULT_LOCAL, "SearXNG localUrl tried first");
  } finally {
    restore();
  }
});

test("ddg fallback: NOT used when useDuckDuckGoFallback:false and all SearXNG endpoints fail -> throws", async () => {
  const { sys } = await setup({ useDuckDuckGoFallback: false });
  const { urls, restore } = installFetch((u) => {
    if (u.includes("duckduckgo.com")) {
      return makeResponse({ ok: true, text: async () => DDG_HTML });
    }
    return makeResponse({ ok: false, status: 500 });
  });
  try {
    await assert.rejects(sys.actions.invoke(SEARCH, { query: "q" }));
    assert.ok(
      !urls.some((u) => u.includes("duckduckgo.com")),
      "DuckDuckGo must NOT be queried when the fallback is disabled",
    );
  } finally {
    restore();
  }
});

// ===========================================================================
// 8. all endpoints fail -> action THROWS naming the tried endpoints
// ===========================================================================

test("all-fail: every endpoint returns non-2xx -> action throws naming tried endpoints", async () => {
  // DuckDuckGo also fails here (HTTP error) so the whole waterfall is exhausted.
  const { sys } = await setup({ publicInstances: DEFAULT_PUBLIC });
  const { urls, restore } = installFetch(() => makeResponse({ ok: false, status: 502 }));
  try {
    await assert.rejects(
      sys.actions.invoke(SEARCH, { query: "q" }),
      (err: any) => {
        const msg = String(err?.message ?? err);
        // The message must name at least the local endpoint and one public one it tried.
        assert.ok(
          msg.includes(DEFAULT_LOCAL) || msg.includes("localhost"),
          "error message must name the local endpoint",
        );
        assert.ok(
          DEFAULT_PUBLIC.some((p) => msg.includes(p) || msg.includes(originOf(p))),
          "error message must name a tried public endpoint",
        );
        return true;
      },
    );
    // It tried the full waterfall: local + all public instances + DuckDuckGo.
    assert.ok(
      urls.length >= 1 + DEFAULT_PUBLIC.length,
      "tried at least local + every public instance",
    );
  } finally {
    restore();
  }
});

test("all-fail: every endpoint throws on fetch -> action still throws (no silent resolve)", async () => {
  const { sys } = await setup({});
  const { restore } = installFetch(() => {
    throw new Error("offline");
  });
  try {
    await assert.rejects(sys.actions.invoke(SEARCH, { query: "q" }));
  } finally {
    restore();
  }
});

// ===========================================================================
// 9. instanceUrl pin — ONLY that url is fetched
// ===========================================================================

test("instanceUrl: set -> ONLY that url is fetched; localUrl & public NOT hit", async () => {
  const pinned = "https://my.searx.internal";
  const { sys } = await setup({ instanceUrl: pinned });
  const { urls, restore } = installFetch(() =>
    makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "P", url: "https://p/1", content: "c" }]),
    }),
  );
  try {
    const res: any = await sys.actions.invoke(SEARCH, { query: "q" });
    assert.equal(res.results[0].title, "P");
    assert.equal(urls.length, 1, "exactly one endpoint attempted");
    assert.equal(originOf(urls[0]), pinned, "only the pinned instanceUrl is hit");
    for (const u of urls) {
      assert.notEqual(originOf(u), DEFAULT_LOCAL, "localUrl must NOT be hit when instanceUrl is set");
      for (const pub of DEFAULT_PUBLIC) {
        assert.notEqual(originOf(u), pub, "public instances must NOT be hit when instanceUrl is set");
      }
    }
  } finally {
    restore();
  }
});

test("instanceUrl: set but failing -> throws WITHOUT trying local/public/DDG (only one attempt)", async () => {
  const pinned = "https://my.searx.internal";
  const { sys } = await setup({ instanceUrl: pinned });
  const { urls, restore } = installFetch(() => makeResponse({ ok: false, status: 500 }));
  try {
    await assert.rejects(sys.actions.invoke(SEARCH, { query: "q" }));
    assert.equal(urls.length, 1, "a pinned instance failing must not fall through to defaults");
    assert.equal(originOf(urls[0]), pinned);
    assert.ok(
      !urls.some((u) => u.includes("duckduckgo.com")),
      "a pinned instance must not fall through to DuckDuckGo either",
    );
  } finally {
    restore();
  }
});

// ===========================================================================
// 10. usePublicFallback:false — only localUrl attempted
// ===========================================================================

test("usePublicFallback:false, no instanceUrl, no DDG -> only localUrl attempted", async () => {
  const { sys } = await setup({ usePublicFallback: false, useDuckDuckGoFallback: false });
  const { urls, restore } = installFetch(() => makeResponse({ ok: false, status: 500 }));
  try {
    await assert.rejects(sys.actions.invoke(SEARCH, { query: "q" }));
    assert.equal(urls.length, 1, "only one endpoint (localUrl) attempted");
    assert.equal(originOf(urls[0]), DEFAULT_LOCAL, "the sole attempt is localUrl");
  } finally {
    restore();
  }
});

test("usePublicFallback:true (default), localUrl fails -> public instances ARE tried", async () => {
  const { sys } = await setup({ publicInstances: DEFAULT_PUBLIC });
  const { urls, restore } = installFetch(() => makeResponse({ ok: false, status: 500 }));
  try {
    await assert.rejects(sys.actions.invoke(SEARCH, { query: "q" }));
    assert.ok(urls.length > 1, "the waterfall extends past localUrl into the public list");
    assert.equal(originOf(urls[1]), DEFAULT_PUBLIC[0], "first fallback is the first public instance");
  } finally {
    restore();
  }
});

// ===========================================================================
// 11. timeout — abortable, robust (no real wall-clock dependency)
// ===========================================================================

// The stub never resolves on its own but rejects when the AbortController fires.
// With a tiny timeoutMs and usePublicFallback:false (one endpoint), the action
// must reject rather than hang. We bound the whole test on a generous timer so a
// truly-hung impl fails loudly instead of stalling the suite.
test("timeout: a never-resolving endpoint that honors the abort signal -> action rejects (not hung)", async () => {
  const { sys } = await setup({
    usePublicFallback: false,
    useDuckDuckGoFallback: false,
    timeoutMs: 30,
  });
  const original = globalThis.fetch;
  (globalThis as any).fetch = (_url: any, init?: any) =>
    new Promise((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }
      // Otherwise never resolves — relies on the abort to settle.
    });
  try {
    const guard = new Promise((_r, reject) =>
      setTimeout(() => reject(new Error("TEST-TIMEOUT: action hung past its own timeoutMs")), 5000),
    );
    await assert.rejects(Promise.race([sys.actions.invoke(SEARCH, { query: "q" }), guard]));
  } finally {
    (globalThis as any).fetch = original;
  }
});

test("timeout: passes an AbortSignal to fetch (request is abortable)", async () => {
  const { sys } = await setup({ usePublicFallback: false, useDuckDuckGoFallback: false });
  let sawSignal = false;
  const original = globalThis.fetch;
  (globalThis as any).fetch = async (_url: any, init?: any) => {
    if (init && "signal" in init && init.signal) sawSignal = true;
    return makeResponse({
      ok: true,
      json: async () => searxBody([{ title: "T", url: "https://a/1", content: "c" }]),
    });
  };
  try {
    await sys.actions.invoke(SEARCH, { query: "q" });
    assert.ok(sawSignal, "fetch must be invoked with an abort signal so requests can time out");
  } finally {
    (globalThis as any).fetch = original;
  }
});

// ===========================================================================
// 12. tool.result loop (Events.TOOL_RESULT -> web-search.results block)
// ===========================================================================

// Emit a tool.result envelope (Reply<unknown> & { name }) on the bus, as the
// orchestrator does for each settled tool call.
let _resSeq = 0;
function emitToolResult(
  sys: ReturnType<typeof createEventSystem>,
  fields: { name: string; ok: boolean; data?: unknown; error?: string },
) {
  sys.events.emit(Events.TOOL_RESULT, {
    id: "tr-" + ++_resSeq,
    at: Date.now(),
    ok: fields.ok,
    name: fields.name,
    data: fields.data,
    error: fields.error,
  });
}

// The shape of a successful web-search.search return — what the orchestrator
// carries as the tool.result `data` field.
function successData(query = "q") {
  return {
    endpoint: "http://localhost:8080",
    query,
    results: [{ title: "T", url: "https://a/1", snippet: "snip" }],
  };
}

test("result loop: an own ok:true result -> one {role:'user', name:'web-search'} message tagged 'ok'", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("kittens") });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1);
  const m = msgs[0];
  assert.equal(m.role, "user");
  assert.equal(m.name, "web-search");
  const content = String(m.content);
  assert.match(content, /web-search\.search/, "header names the tool");
  assert.match(content, /\bok\b/, "header marks success as ok");
});

test("result loop: a FOREIGN tool.result name is ignored (block stays empty)", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: "krakeycode.read_file", ok: true, data: { content: "x" } });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "another tool's result must not enter the web-search ring");
});

test("result loop: an ok:false result -> rendered content surfaces the failure with a 'Tell the user' nudge", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: false, error: "oops" });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1);
  const content = String(msgs[0].content);
  assert.match(content, /FAILED/, "header marks the failure with 'FAILED'");
  assert.match(content, /Tell the user/, "body instructs the model to surface the failure to the user");
  assert.match(content, /oops/, "body carries the underlying error message");
});

test("result loop: ring bounded by maxResults (emit maxResults+1, keep only last maxResults)", async () => {
  const max = 3;
  const { store, sys } = await setup({ maxResults: max });
  for (let i = 0; i < max + 1; i++) {
    emitToolResult(sys, { name: SEARCH, ok: true, data: successData(`q${i}`) });
  }
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, max, "ring keeps exactly maxResults entries");
  // The very first (q0) must have been dropped; the last (q3) must be present.
  const all = msgs.map((m) => String(m.content)).join("\n");
  assert.ok(!all.includes("q0"), "oldest entry (q0) was evicted");
  assert.ok(all.includes("q3"), "newest entry (q3) retained");
});

test("result loop: invokes clock.fire_now after an own result when that action is registered", async () => {
  const { sys } = await setup({});
  let fired = 0;
  sys.actions.register(Actions.CLOCK_FIRE_NOW, async () => {
    fired++;
    return undefined;
  });
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData() });
  await new Promise((r) => setTimeout(r, 20)); // let the fire-and-forget settle
  assert.ok(fired >= 1, "clock.fire_now must be invoked after recording an own result");
});

test("result loop: does NOT invoke clock.fire_now for a FOREIGN result", async () => {
  const { sys } = await setup({});
  let fired = 0;
  sys.actions.register(Actions.CLOCK_FIRE_NOW, async () => {
    fired++;
    return undefined;
  });
  emitToolResult(sys, { name: "web-chat.send_message", ok: true, data: { delivered: true } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fired, 0, "a foreign tool result must not trigger a frame");
});

test("result loop: does NOT throw when clock.fire_now is not registered", async () => {
  const { sys } = await setup({});
  assert.equal(sys.actions.has(Actions.CLOCK_FIRE_NOW), false, "precondition: no clock action");
  assert.doesNotThrow(() => {
    emitToolResult(sys, { name: SEARCH, ok: true, data: successData() });
  });
  await new Promise((r) => setTimeout(r, 20));
});

// ===========================================================================
// 13. total-char budgeting — oldest degrades to header-only
// ===========================================================================

test("budget: combined size over maxResultsTotalChars -> the OLDER entry renders header-only (shorter)", async () => {
  // Two large bodies; per-result cap generous so it doesn't trigger here, but the
  // TOTAL budget is tiny so the older entry must shed its body.
  const big = "y".repeat(400);
  const { store, sys } = await setup({
    maxResults: 10,
    maxResultChars: 5000,
    maxResultsTotalChars: 500,
  });
  // Record the OLDER one first, then the NEWER one.
  emitToolResult(sys, {
    name: SEARCH,
    ok: true,
    data: {
      endpoint: "http://localhost:8080",
      query: "older",
      results: [{ title: "OLD", url: "https://a/old", snippet: big }],
    },
  });
  emitToolResult(sys, {
    name: SEARCH,
    ok: true,
    data: {
      endpoint: "http://localhost:8080",
      query: "newer",
      results: [{ title: "NEW", url: "https://a/new", snippet: big }],
    },
  });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.ok(msgs.length >= 2, "both entries rendered (older degraded, not dropped)");

  const joined = msgs.map((m) => String(m.content));
  // Identify older vs newer by their query tag in the header.
  const olderMsg = joined.find((c) => /older/.test(c));
  const newerMsg = joined.find((c) => /newer/.test(c));
  assert.ok(olderMsg, "older entry still present (as a header line)");
  assert.ok(newerMsg, "newer entry present");

  // Newest keeps its full body; oldest is stripped to a shorter header-only line.
  assert.ok(String(newerMsg).includes(big), "newest message keeps its full body");
  assert.ok(!String(olderMsg).includes(big), "oldest message is stripped of its large body");
  assert.ok(
    String(olderMsg).length < String(newerMsg).length,
    `older header-only (${String(olderMsg).length}) must be shorter than newer full (${String(newerMsg).length})`,
  );
});

// ===========================================================================
// 14. teardown
// ===========================================================================

test("teardown: removes both context blocks", async () => {
  const { p, store } = await setup({});
  assert.ok(store.get(GUIDANCE_BLOCK), "guidance present before teardown");
  assert.ok(store.get(RESULTS_BLOCK), "results present before teardown");
  await p.teardown();
  assert.equal(store.get(GUIDANCE_BLOCK), undefined, "guidance removed");
  assert.equal(store.get(RESULTS_BLOCK), undefined, "results removed");
});

test("teardown: unregisters the web-search.search action", async () => {
  const { p, sys } = await setup({});
  assert.ok(sys.actions.list().includes(SEARCH), "search registered before teardown");
  await p.teardown();
  assert.ok(!sys.actions.list().includes(SEARCH), "web-search.search unregistered after teardown");
});

test("teardown: is idempotent (double teardown does not throw)", async () => {
  const { p } = await setup({});
  await p.teardown();
  await assert.doesNotReject(async () => {
    await p.teardown();
  }, "second teardown must not throw");
});

// ===========================================================================
// 15. parseDuckDuckGoLite — pure helper (exported from search.ts)
// ===========================================================================

// parseDuckDuckGoLite(html, maxResults, maxSnippetChars) decodes the real URL
// out of the `uddg` query param, strips HTML tags + entities from title/snippet,
// caps the count at maxResults, and truncates snippets to maxSnippetChars.
test("parseDuckDuckGoLite: parses the deterministic sample into decoded {title,url,snippet}", () => {
  assert.ok(
    helpers && typeof helpers.parseDuckDuckGoLite === "function",
    "search.ts must export parseDuckDuckGoLite",
  );
  const out = helpers.parseDuckDuckGoLite(DDG_HTML, 5, 400);
  assert.deepEqual(out, [
    {
      title: "Node.js Downloads & Docs",
      url: "https://nodejs.org/download",
      snippet: "Node.js's official site.",
    },
    { title: "Example Page", url: "https://example.com/a", snippet: "An example snippet." },
  ]);
});

test("parseDuckDuckGoLite: maxResults caps the count (pass 1 -> length 1)", () => {
  assert.ok(
    helpers && typeof helpers.parseDuckDuckGoLite === "function",
    "search.ts must export parseDuckDuckGoLite",
  );
  const out = helpers.parseDuckDuckGoLite(DDG_HTML, 1, 400);
  assert.equal(out.length, 1, "count capped to maxResults");
  assert.equal(out[0].title, "Node.js Downloads & Docs", "the FIRST result is kept");
});

test("parseDuckDuckGoLite: maxSnippetChars truncates a long snippet", () => {
  assert.ok(
    helpers && typeof helpers.parseDuckDuckGoLite === "function",
    "search.ts must export parseDuckDuckGoLite",
  );
  // A DDG body with a long (>cap) snippet on the single result.
  const longSnippet = "z".repeat(200);
  const html =
    `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Flong&amp;rut=x1" class='result-link'>Long</a> <td class='result-snippet'>${longSnippet}</td>`;
  const cap = 20;
  const out = helpers.parseDuckDuckGoLite(html, 5, cap);
  assert.equal(out.length, 1, "one result parsed");
  const snip = String(out[0].snippet);
  assert.ok(snip.length <= cap + 1, `snippet (${snip.length}) must be ~<= cap (${cap}) + ellipsis`);
  assert.ok(snip.length < longSnippet.length, "snippet shorter than the source");
});

// ===========================================================================
// 16. other pure-helper unit tests (TOLERANT — skip cleanly until search.ts exists)
// ===========================================================================

test("helpers.readConfig: applies documented defaults over an empty slice", () => {
  if (!helpers || typeof helpers.readConfig !== "function") return; // tolerant skip
  const cfg: any = helpers.readConfig({});
  assert.equal(cfg.instanceUrl, null);
  assert.equal(cfg.localUrl, DEFAULT_LOCAL);
  assert.deepEqual(cfg.publicInstances, []);
  assert.equal(cfg.usePublicFallback, true);
  assert.equal(cfg.useDuckDuckGoFallback, true);
  assert.equal(cfg.language, "auto");
  assert.equal(cfg.categories, "general");
  assert.equal(cfg.safesearch, 0);
  assert.equal(cfg.timeoutMs, 10000);
  assert.equal(cfg.maxResults, 5);
  assert.equal(cfg.maxSnippetChars, 400);
  assert.equal(cfg.maxResultChars, 1200);
  assert.equal(cfg.maxResultsTotalChars, 12000);
  assert.equal(cfg.guidancePriority, 6000);
  assert.equal(cfg.resultsPriority, 3500);
});

test("helpers.resolveEndpoints: instanceUrl set -> ONLY [instanceUrl]", () => {
  if (!helpers || typeof helpers.resolveEndpoints !== "function") return; // tolerant skip
  const cfg: any = (helpers.readConfig ? helpers.readConfig : (x: any) => x)({
    instanceUrl: "https://pinned",
  });
  const eps = helpers.resolveEndpoints(cfg);
  assert.deepEqual(eps, ["https://pinned"]);
});

test("helpers.resolveEndpoints: no instanceUrl + fallback -> [localUrl, ...public]", () => {
  if (!helpers || typeof helpers.resolveEndpoints !== "function") return; // tolerant skip
  const cfg: any = (helpers.readConfig ? helpers.readConfig : (x: any) => x)({
    publicInstances: DEFAULT_PUBLIC,
  });
  const eps = helpers.resolveEndpoints(cfg);
  assert.equal(eps[0], DEFAULT_LOCAL);
  assert.deepEqual(eps.slice(1), DEFAULT_PUBLIC);
});

test("helpers.resolveEndpoints: usePublicFallback:false -> [localUrl] only", () => {
  if (!helpers || typeof helpers.resolveEndpoints !== "function") return; // tolerant skip
  const cfg: any = (helpers.readConfig ? helpers.readConfig : (x: any) => x)({
    usePublicFallback: false,
  });
  const eps = helpers.resolveEndpoints(cfg);
  assert.deepEqual(eps, [DEFAULT_LOCAL]);
});

test("helpers.buildSearchUrl: contains format=json and the query", () => {
  if (!helpers || typeof helpers.buildSearchUrl !== "function") return; // tolerant skip
  const cfg: any = (helpers.readConfig ? helpers.readConfig : (x: any) => x)({});
  const url = String(helpers.buildSearchUrl(DEFAULT_LOCAL, "cats", 1, cfg));
  assert.match(url, /format=json/, "must request JSON");
  assert.match(url, /[?&]q=/, "must carry a q parameter");
});

test("helpers.normalizeResults: throws when results is missing/not an array", () => {
  if (!helpers || typeof helpers.normalizeResults !== "function") return; // tolerant skip
  assert.throws(() => helpers.normalizeResults({}, 5, 400), "missing results must throw");
  assert.throws(
    () => helpers.normalizeResults({ results: "nope" }, 5, 400),
    "non-array results must throw",
  );
});

test("helpers.truncateSnippet: boundary — at/under cap unchanged, over cap gets an ellipsis", () => {
  if (!helpers || typeof helpers.truncateSnippet !== "function") return; // tolerant skip
  assert.equal(helpers.truncateSnippet("abc", 3), "abc", "at the cap is unchanged");
  assert.equal(helpers.truncateSnippet("ab", 3), "ab", "under the cap is unchanged");
  const over = String(helpers.truncateSnippet("abcdef", 3));
  assert.ok(over.length <= 4, "over the cap is truncated to ~cap (+ ellipsis)");
  assert.match(over, /…$/, "over-cap result ends with an ellipsis");
});

// ===========================================================================
// 17. context-pressure shedding  (Events.CONTEXT_FULL -> drop oldest entries)
// ===========================================================================
//
// NEW behavior. When llm-core finds the assembled prompt over the model's
// context budget it emits `context.full` SYNCHRONOUSLY (fire-and-forget) so
// MESSAGES-block plugins shrink BEFORE the immediately-following re-compose.
//
// Contract (shared/actions EventPayloads["context.full"]):
//   payload = Notify<{ estimatedTokens; limit; overBy; round }>
//           = { at: number, data: { estimatedTokens, limit, overBy, round } }
//   `round` increments with each successive emission within one frame so
//   reactors can shed PROPORTIONALLY.
//
// Spec for web-search specifically:
//   - on `context.full {round:R}` it SYNCHRONOUSLY drops the R OLDEST entries
//     from its `web-search.results` ring (oldest-first); render() then returns
//     fewer messages. `round:0` is a no-op.
//   - on `Events.LLM_RETURN` the shed-pressure RESETS for the next frame.
//
// These tests populate the ring through the SAME `tool.result` mechanism the
// section-12 tests use, capture the `web-search.results` MESSAGES block, and
// read `render()`. Each entry carries a UNIQUE query tag (q0,q1,…) so "dropped"
// (tag absent from EVERY rendered message) is distinguishable from a mere
// budget degrade-to-header (section 13), which keeps the tag in a header line.
// Char budgets are kept slack and snippets tiny so ONLY pressure can shrink the
// ring here.

// Emit a `context.full` event matching the Notify<T> envelope ({ at, data }).
function emitContextFull(
  sys: ReturnType<typeof createEventSystem>,
  round: number,
  over: { estimatedTokens?: number; limit?: number; overBy?: number } = {},
) {
  sys.events.emit(Events.CONTEXT_FULL, {
    at: Date.now(),
    data: {
      estimatedTokens: over.estimatedTokens ?? 9000,
      limit: over.limit ?? 8000,
      overBy: over.overBy ?? 1000,
      round,
    },
  });
}

// Emit an `llm.return` event (Reply<LLMResponse>) — only the envelope matters
// for the reset signal; the body can be a minimal stand-in.
function emitLlmReturn(sys: ReturnType<typeof createEventSystem>) {
  sys.events.emit(Events.LLM_RETURN, {
    id: "llm-" + Date.now(),
    at: Date.now(),
    ok: true,
    data: { message: { role: "assistant", content: "" } },
  });
}

// Populate the ring with N own ok:true results, each tagged q0..q(N-1) (oldest
// first). Slack budgets + tiny snippets so neither maxResults nor char-budget
// degradation interferes — only context.full pressure can shrink it.
async function setupWithEntries(n: number) {
  const { store, sys, p } = await setup({
    maxResults: Math.max(n, 1),
    maxResultChars: 100000,
    maxResultsTotalChars: 10000000,
    maxSnippetChars: 4000,
  });
  for (let i = 0; i < n; i++) {
    emitToolResult(sys, {
      name: SEARCH,
      ok: true,
      data: {
        endpoint: "http://localhost:8080",
        query: `q${i}`,
        results: [{ title: `T${i}`, url: `https://a/${i}`, snippet: `s${i}` }],
      },
    });
  }
  return { store, sys, p };
}

// Which q-tags survive in the rendered block (a tag absent from EVERY message
// means that entry was DROPPED, not merely degraded to a header).
async function survivingTags(store: Map<string, ContextBlock>, n: number): Promise<number[]> {
  const msgs = await renderMsgs(resultsBlock(store));
  const joined = msgs.map((m) => String(m.content)).join("\n");
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (new RegExp(`\\bq${i}\\b`).test(joined)) out.push(i);
  }
  return out;
}

// ---- 17a. positive — pressure drops the oldest, render reflects it ----

test("ctx-pressure (positive): baseline — N entries all render before any pressure", async () => {
  const N = 4;
  const { store } = await setupWithEntries(N);
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, N, "all N entries present before any context.full");
  assert.deepEqual(await survivingTags(store, N), [0, 1, 2, 3], "every tag q0..q3 present");
});

test("ctx-pressure (positive): round:1 drops the SINGLE oldest entry (q0), render shrinks by one", async () => {
  const N = 4;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 1);
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, N - 1, "exactly one entry shed after round:1");
  const tags = await survivingTags(store, N);
  assert.ok(!tags.includes(0), "the OLDEST entry (q0) is dropped");
  assert.deepEqual(tags, [1, 2, 3], "q1..q3 survive in order");
});

test("ctx-pressure (positive): reaction is SYNCHRONOUS — render right after emit already shrank", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 1); // no await/tick between emit and render
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, N - 1, "the drop landed synchronously within emit()");
});

// ---- 17b. boundary value analysis on `round` ----

test("ctx-pressure (BVA): round:0 is a NO-OP — nothing is dropped", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 0);
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, N, "round:0 drops nothing");
  assert.deepEqual(await survivingTags(store, N), [0, 1, 2], "all tags intact after round:0");
});

test("ctx-pressure (BVA): round:2 drops the TWO oldest (oldest-first)", async () => {
  const N = 4;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 2);
  const tags = await survivingTags(store, N);
  assert.equal((await renderMsgs(resultsBlock(store))).length, N - 2, "two entries shed at round:2");
  assert.ok(!tags.includes(0) && !tags.includes(1), "q0 and q1 (the two oldest) are gone");
  assert.deepEqual(tags, [2, 3], "q2,q3 survive");
});

test("ctx-pressure (BVA): round === buffer size drops everything -> empty block", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, N);
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "round == size empties the ring");
});

test("ctx-pressure (BVA): round GREATER than buffer size clamps to empty (no throw, no negatives)", async () => {
  const N = 2;
  const { store, sys } = await setupWithEntries(N);
  assert.doesNotThrow(() => emitContextFull(sys, N + 5), "over-large round must not throw");
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "an over-large round empties the ring rather than going negative");
});

test("ctx-pressure (BVA): round:1 on an EMPTY ring is a harmless no-op", async () => {
  const { store, sys } = await setup({}); // nothing recorded
  assert.doesNotThrow(() => emitContextFull(sys, 1), "pressure on an empty ring must not throw");
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "still empty");
});

test("ctx-pressure (BVA): round:1 on a SINGLE-entry ring empties it", async () => {
  const { store, sys } = await setupWithEntries(1);
  emitContextFull(sys, 1);
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "the lone entry is the oldest and is dropped");
});

// ---- 17c. state-transition — successive rounds, reset, re-pressure ----

test("ctx-transition: successive rounds within a frame shed PROPORTIONALLY (1 then 2 -> three gone total)", async () => {
  // Spec: `round` increments per emission within ONE frame; the plugin sheds the
  // R oldest each time, so a round:1 then round:2 leaves the 3 oldest gone.
  const N = 5;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 1); // shed oldest 1 -> q0 gone
  emitContextFull(sys, 2); // shed oldest 2 -> q1,q2 gone
  const tags = await survivingTags(store, N);
  assert.deepEqual(tags, [3, 4], "q0,q1,q2 shed across the two escalating rounds");
});

// NEW behavior (spec J / Finding J): the llm.return handler now ALSO clears the
// results ring (`results = []; pressureRound = 0`) — one-shot delivery. This test
// was rewritten from the OLD "the unshed survivor q2 is retained across the reset"
// assertion (same treatment as the browser suite's 'does NOT restore
// already-dropped' rewrite): the survivor is no longer retained — the return
// empties the ring, so only entries recorded AFTER the return remain.
// F2 note: this ring is ALL-OK (setupWithEntries emits ok:true only), so
// llm.return empties it fully — there is no persistent-failure ledger to survive.
// The failure-persistence path is covered by the F2 battery below.
test("ctx-transition: LLM_RETURN empties the ring — the unshed survivor is dropped, only post-return entries render", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 2); // drop q0,q1 -> only q2 left
  assert.deepEqual(await survivingTags(store, N), [2], "two oldest shed this frame");

  emitLlmReturn(sys); // frame ends; llm.return DROPS the whole ring + resets pressure
  assert.deepEqual(
    await renderMsgs(resultsBlock(store)),
    [],
    "llm.return empties the results ring (one-shot delivery)",
  );

  // A fresh frame records a new entry; the ring started empty, so ONLY qNEW renders.
  emitToolResult(sys, {
    name: SEARCH,
    ok: true,
    data: {
      endpoint: "http://localhost:8080",
      query: "qNEW",
      results: [{ title: "TNEW", url: "https://a/new", snippet: "snew" }],
    },
  });
  const msgs = await renderMsgs(resultsBlock(store));
  const joined = msgs.map((m) => String(m.content)).join("\n");
  assert.equal(msgs.length, 1, "ring started empty after the return; only the post-return entry renders");
  assert.match(joined, /\bqNEW\b/, "the post-return entry renders");
  assert.ok(!/\bq2\b/.test(joined), "the pre-return survivor q2 was cleared by the return — not retained");
});

// NEW behavior (spec J): rewritten from the OLD assertion that frame-1 survivors
// (q1,q2) persisted past the return so a frame-2 round:1 could shed q1. Now
// llm.return empties the ring AND zeroes pressure; the frame-2 round:1 sheds one
// current-oldest from the NEW (post-return) buffer, proving the counter reset.
test("ctx-transition: after LLM_RETURN clears the ring, a fresh round:1 sheds one current-oldest from the NEW buffer", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N); // q0,q1,q2
  emitContextFull(sys, 1); // q0 gone -> survivors [q1,q2]
  emitLlmReturn(sys); // frame boundary: clears the ring AND resets pressure
  assert.deepEqual(await renderMsgs(resultsBlock(store)), [], "llm.return empties the ring");

  // Frame 2: two fresh entries, then a fresh round:1 sheds exactly one current-oldest
  // (qA) — NOT two from stale accumulated pressure.
  for (const q of ["qA", "qB"]) {
    emitToolResult(sys, {
      name: SEARCH,
      ok: true,
      data: {
        endpoint: "http://localhost:8080",
        query: q,
        results: [{ title: q, url: `https://a/${q}`, snippet: q }],
      },
    });
  }
  emitContextFull(sys, 1); // drop the current-oldest (qA) only
  const msgs = await renderMsgs(resultsBlock(store));
  const joined = msgs.map((m) => String(m.content)).join("\n");
  assert.equal(msgs.length, 1, "one fresh entry shed by round:1, one survives (pressure reset — not carried)");
  assert.ok(!/\bqA\b/.test(joined), "frame-2 round:1 drops the current-oldest (qA)");
  assert.match(joined, /\bqB\b/, "the newer fresh entry survives");
  assert.ok(
    !/\bq1\b/.test(joined) && !/\bq2\b/.test(joined),
    "frame-1 entries were cleared by the return — not restored",
  );
});

test("ctx-transition: an entry dropped by pressure does NOT reappear on the next render (persistent within frame)", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N);
  emitContextFull(sys, 1);
  const first = await survivingTags(store, N);
  const second = await survivingTags(store, N); // render again, no new events
  assert.deepEqual(first, [1, 2], "q0 shed on first render");
  assert.deepEqual(second, first, "the shed is persistent — q0 stays gone across renders");
});

// ---- 17d. negative / robustness ----

test("ctx-pressure (negative): a foreign agent's later results are unaffected — only OWN ring shrinks", async () => {
  // A foreign tool.result must never have entered the ring (section 12); pressure
  // therefore operates only on web-search's OWN entries. Interleave a foreign
  // result and assert the ring count tracks ONLY the own entries minus the shed.
  const { store, sys } = await setup({
    maxResults: 5,
    maxResultChars: 100000,
    maxResultsTotalChars: 10000000,
  });
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("own0") });
  emitToolResult(sys, { name: "krakeycode.read_file", ok: true, data: { content: "x" } });
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("own1") });
  assert.equal((await renderMsgs(resultsBlock(store))).length, 2, "two own entries; foreign ignored");
  emitContextFull(sys, 1);
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1, "exactly one own entry shed");
  assert.match(String(msgs[0].content), /own1/, "the surviving own entry is the newer one");
});

test("ctx-pressure (negative): the guidance (system) block is untouched by context.full", async () => {
  const { store, sys } = await setupWithEntries(3);
  const before = await renderStr(guidanceBlock(store));
  emitContextFull(sys, 2);
  const after = await renderStr(guidanceBlock(store));
  assert.equal(after, before, "context.full must not alter the system guidance block");
});

test("ctx-pressure (negative): a NEGATIVE round is treated as a no-op (no throw, nothing dropped)", async () => {
  const N = 3;
  const { store, sys } = await setupWithEntries(N);
  assert.doesNotThrow(() => emitContextFull(sys, -1 as number), "a negative round must not throw");
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, N, "a negative round drops nothing (treated like round:0)");
});

test("ctx-pressure (negative): a malformed payload (missing data) does not throw or corrupt the ring", async () => {
  const N = 2;
  const { store, sys } = await setupWithEntries(N);
  assert.doesNotThrow(() => sys.events.emit(Events.CONTEXT_FULL, {} as unknown),
    "a payload with no data field must be tolerated");
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, N, "a malformed context.full leaves the ring intact");
});

// NEW behavior (spec J): rewritten from the OLD "a bare reset leaves the ring
// untouched (msgs.length === N)" assertion. Under one-shot delivery, llm.return
// ALWAYS empties the ring — even with no preceding pressure — so the block becomes
// []. The handler still must not throw.
test("ctx-pressure (negative): LLM_RETURN with no preceding pressure still empties the ring (one-shot), no throw", async () => {
  const N = 2;
  const { store, sys } = await setupWithEntries(N);
  assert.doesNotThrow(() => emitLlmReturn(sys), "a bare return must not throw");
  const msgs = await renderMsgs(resultsBlock(store));
  assert.deepEqual(msgs, [], "llm.return empties the ring even without preceding pressure (one-shot delivery)");
});

// ===========================================================================
// 18. one-shot results delivery (spec J / Finding J)
// ===========================================================================
//
// NEW behavior: the Events.LLM_RETURN handler now ALSO clears the tool-results
// ring (`results = []; pressureRound = 0`). One-shot delivery: results render
// into web-search.results on the frame AFTER the tool ran; an llm.return empties
// the ring. Frame-order guarantee: llm.return fires BEFORE this frame's
// tool.result events, so results emitted after a return survive to the next
// render. These tests use the section-12 emitToolResult mechanism + emitLlmReturn
// (section 17) and observe the web-search.results MESSAGES block.

// F2 success/failure split: llm.return empties the RESULTS ring only — the
// separate persistent-FAILURE ledger is NOT cleared by llm.return (see the F2
// battery below). This ring is ALL-OK, so the rendered block goes fully empty.
test("llm.return (one-shot): >=2 own ok:true tool.results render, then llm.return empties the ring", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("ring0") });
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("ring1") });
  const before = await renderMsgs(resultsBlock(store));
  assert.equal(before.length, 2, "both own results render before the return");

  emitLlmReturn(sys); // one-shot delivery: drop the whole (all-ok) ring

  const after = await renderMsgs(resultsBlock(store));
  assert.deepEqual(after, [], "llm.return clears an all-ok results ring");
});

test("llm.return (frame-order): results emitted AFTER the return survive to the NEXT render", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("ring0") });
  // Frame boundary: llm.return fires BEFORE this frame's tool.result events.
  emitLlmReturn(sys);
  assert.deepEqual(await renderMsgs(resultsBlock(store)), [], "ring empty right after the return");

  // Results emitted AFTER the return must survive to the next render.
  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("ringNEW") });
  const msgs = await renderMsgs(resultsBlock(store));
  assert.equal(msgs.length, 1, "the post-return result survives to the next render");
  assert.match(
    msgs.map((m) => String(m.content)).join("\n"),
    /\bringNEW\b/,
    "the post-return result renders in full",
  );
});

test("llm.return (empty ring): on an empty ring is a no-op / does not throw", async () => {
  const { store, sys } = await setup({});
  assert.deepEqual(await renderMsgs(resultsBlock(store)), [], "precondition: empty ring");
  assert.doesNotThrow(() => emitLlmReturn(sys), "llm.return on an empty ring must not throw");
  assert.deepEqual(await renderMsgs(resultsBlock(store)), [], "still empty after the return");
});

// ===========================================================================
// 19. F2 — persistent FAILURE LEDGER, folded into the web-search.results block.
//
// NEW behavior (black-box, derived ONLY from the F2 spec — impl does not exist,
// so the discriminating tests are RED against main by design):
//
//   * On an OWN tool.result with ok===false, upsert a ledger entry keyed by
//     (toolName + NORMALIZED error): trimmed, 'unknown' when empty, capped ~300
//     chars — {count, firstAt, lastAt}. Same (tool,error) bumps count; a DISTINCT
//     error is a separate entry.
//   * On an OWN ok===true result for a tool, ALL its ledger entries are removed.
//   * Bounded by config `maxFailureNotices` (default 8; 0 disables the feature).
//   * Events.LLM_RETURN clears the RESULTS ring + resets pressure but does NOT
//     clear the failure ledger (the success/failure split).
//   * Events.CONTEXT_FULL sheds failure entries oldest-first (slice(round)).
//   * teardown resets the ledger.
//
//   RENDERING (folded into the SAME web-search.results MESSAGES block): an entry
//   with count>=2 renders ONE {role:'user', name:'web-search'} message naming the
//   tool, the count ('has failed <N>x in a row'), the error, and the reflect-and-
//   stop nudge ('retrying the same call unchanged will NOT succeed'). A count-1
//   failure renders NO persistent line — it only shows as the existing fresh
//   FAILED/'Tell the user' nudge that frame (section 12, which stays intact).
// ===========================================================================

// A "persistent failure line" carries the F2 count phrasing 'failed <N>x in a
// row' (the fresh FAILED/'Tell the user' entries never do).
const FAIL_IN_A_ROW = /failed\s+(\d+)x\s+in a row/i;
function failureLines(msgs: Message[]): string[] {
  return msgs.map((m) => String(m.content)).filter((c) => FAIL_IN_A_ROW.test(c));
}
function failureCount(content: string): number | null {
  const m = FAIL_IN_A_ROW.exec(content);
  return m ? Number(m[1]) : null;
}

// ---- (a) two identical ok:false -> one count-2 persistent line survives return ----

test("F2 (a): two identical ok:false for the search tool -> after llm.return, a count-2 persistent line naming the tool+error renders; the fresh ring entries are gone", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: false, error: "all endpoints failed" });
  emitToolResult(sys, { name: SEARCH, ok: false, error: "all endpoints failed" });

  emitLlmReturn(sys); // clears the RESULTS ring but NOT the failure ledger

  const msgs = await renderMsgs(resultsBlock(store));
  const fails = failureLines(msgs);
  assert.equal(fails.length, 1, "exactly one persistent failure line survives the return");
  const line = fails[0];
  assert.match(line, /web-search\.search/, "persistent line names the tool");
  assert.equal(failureCount(line), 2, "count is 2 (two identical failures in a row)");
  assert.match(line, /all endpoints failed/, "persistent line carries the error text");
  assert.match(
    line,
    /retrying the same call unchanged will NOT succeed/i,
    "persistent line carries the reflect-and-stop nudge",
  );
  assert.equal(msgs.length, 1, "no normal fresh-result entries remain after the return");
});

// ---- web-search extra: the '2x' persistent line coexists with the intact
//      single-failure FAILED/'Tell the user' nudge (spec: section 12 stays intact).

test("F2 (web-search): a single failure still shows the fresh FAILED/'Tell the user' nudge (no 2x line); a 2nd identical failure + llm.return then renders the count-2 line", async () => {
  const { store, sys } = await setup({});

  // First failure: the existing fresh-result behavior — FAILED + 'Tell the user'
  // — is intact, and there is NO persistent 'failed 2x in a row' line yet.
  emitToolResult(sys, { name: SEARCH, ok: false, error: "oops" });
  const afterOne = await renderMsgs(resultsBlock(store));
  assert.equal(afterOne.length, 1, "the fresh failed result renders this frame");
  const one = String(afterOne[0].content);
  assert.match(one, /FAILED/, "existing single-failure behavior: header marks FAILED");
  assert.match(one, /Tell the user/, "existing single-failure behavior: 'Tell the user' nudge intact");
  assert.match(one, /oops/, "existing single-failure behavior: carries the error");
  assert.deepEqual(failureLines(afterOne), [], "no persistent 2x line at count 1");

  // Frame boundary, then a 2nd identical failure promotes the ledger to count 2.
  emitLlmReturn(sys);
  emitToolResult(sys, { name: SEARCH, ok: false, error: "oops" });
  emitLlmReturn(sys);

  const fails = failureLines(await renderMsgs(resultsBlock(store)));
  assert.equal(fails.length, 1, "the count-2 persistent line now renders");
  assert.equal(failureCount(fails[0]), 2, "the persistent line reports 2x");
  assert.match(fails[0], /oops/, "the persistent line carries the error");
});

// ---- (b) two DISTINCT errors from the search tool -> two persistent lines survive ----

test("F2 (b): two DISTINCT errors from the search tool -> two persistent lines survive llm.return", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: false, error: "timeout" });
  emitToolResult(sys, { name: SEARCH, ok: false, error: "timeout" });
  emitToolResult(sys, { name: SEARCH, ok: false, error: "429 rate limited" });
  emitToolResult(sys, { name: SEARCH, ok: false, error: "429 rate limited" });

  emitLlmReturn(sys);

  const fails = failureLines(await renderMsgs(resultsBlock(store)));
  assert.equal(fails.length, 2, "two distinct (tool,error) ledger entries render two persistent lines");
  const joined = fails.join("\n");
  assert.match(joined, /timeout/, "first distinct error present");
  assert.match(joined, /429 rate limited/, "second distinct error present");
  for (const line of fails) assert.equal(failureCount(line), 2, "each distinct error reached count 2");
});

// ---- (c) a later ok:true for that tool -> all its persistent lines gone ----

test("F2 (c): a subsequent ok:true for the search tool clears ALL its persistent lines next render", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: false, error: "boom" });
  emitToolResult(sys, { name: SEARCH, ok: false, error: "boom" });
  emitLlmReturn(sys);
  assert.equal(
    failureLines(await renderMsgs(resultsBlock(store))).length,
    1,
    "precondition: a count-2 persistent line exists",
  );

  emitToolResult(sys, { name: SEARCH, ok: true, data: successData("recovered") });
  emitLlmReturn(sys);

  assert.deepEqual(
    failureLines(await renderMsgs(resultsBlock(store))),
    [],
    "the ok:true wiped the tool's failure ledger — no persistent line renders",
  );
});

// ---- (d) maxFailureNotices:0 -> feature OFF, no persistent line ever ----

test("F2 (d): maxFailureNotices:0 disables the ledger — no persistent line EVER renders", async () => {
  const { store, sys } = await setup({ maxFailureNotices: 0 });
  for (let i = 0; i < 4; i++) emitToolResult(sys, { name: SEARCH, ok: false, error: "all endpoints failed" });
  emitLlmReturn(sys);
  assert.deepEqual(
    failureLines(await renderMsgs(resultsBlock(store))),
    [],
    "maxFailureNotices:0 turns the whole failure-ledger feature off",
  );
});

// ---- (e) context.full sheds failure entries oldest-first, clamped, no throw ----

test("F2 (e): context.full{round:N} sheds failure entries oldest-first, clamped, never throws", async () => {
  const { store, sys } = await setup({ maxFailureNotices: 8 });
  for (const err of ["errA", "errB", "errC"]) {
    emitToolResult(sys, { name: SEARCH, ok: false, error: err });
    emitToolResult(sys, { name: SEARCH, ok: false, error: err });
  }
  emitLlmReturn(sys);
  assert.equal(failureLines(await renderMsgs(resultsBlock(store))).length, 3, "three persistent lines");

  assert.doesNotThrow(() => emitContextFull(sys, 1), "shedding a failure entry must not throw");
  const fails = failureLines(await renderMsgs(resultsBlock(store)));
  assert.equal(fails.length, 2, "one failure entry shed");
  const joined = fails.join("\n");
  assert.ok(!/errA/.test(joined), "the OLDEST failure (errA) was shed first");
  assert.ok(/errB/.test(joined) && /errC/.test(joined), "the two newer failures survive");

  assert.doesNotThrow(() => emitContextFull(sys, 99), "an over-large round must not throw");
  assert.deepEqual(
    failureLines(await renderMsgs(resultsBlock(store))),
    [],
    "shedding more than present empties the ledger, never negative",
  );
});

// ---- (f) ledger bounded by maxFailureNotices: max+1 distinct -> only max kept ----

test("F2 (f): ledger bounded — max+1 distinct (tool,error) failures keep only maxFailureNotices (oldest dropped)", async () => {
  const max = 3;
  const { store, sys } = await setup({ maxFailureNotices: max });
  for (let i = 0; i < max + 1; i++) {
    emitToolResult(sys, { name: SEARCH, ok: false, error: `err-${i}` });
    emitToolResult(sys, { name: SEARCH, ok: false, error: `err-${i}` });
  }
  emitLlmReturn(sys);
  const fails = failureLines(await renderMsgs(resultsBlock(store)));
  assert.equal(fails.length, max, "ledger keeps exactly maxFailureNotices entries");
  const joined = fails.join("\n");
  assert.ok(!/err-0\b/.test(joined), "the oldest distinct failure (err-0) was evicted");
  assert.ok(/err-3\b/.test(joined), "the newest distinct failure (err-3) is retained");
});

// ---- (g) malformed / foreign tool.result never throws through the failure path ----

for (const bad of [
  { label: "null payload", value: null },
  { label: "non-object (string)", value: "oops" },
  { label: "missing name", value: { id: "x", at: 1, ok: false, error: "e" } },
  { label: "name is not a string", value: { id: "x", at: 1, ok: false, name: 42, error: "e" } },
  { label: "ok:false with no error field", value: { id: "x", at: 1, ok: false, name: SEARCH } },
]) {
  test(`F2 (g): malformed tool.result (${bad.label}) never throws through the failure path`, async () => {
    const { store, sys } = await setup({});
    assert.doesNotThrow(() => {
      sys.events.emit(Events.TOOL_RESULT, bad.value);
    }, `malformed failure payload (${bad.label}) must not throw in the listener`);
    emitToolResult(sys, { name: "krakeycode.read_file", ok: false, error: "not mine" });
    emitToolResult(sys, { name: "krakeycode.read_file", ok: false, error: "not mine" });
    emitLlmReturn(sys);
    assert.deepEqual(
      failureLines(await renderMsgs(resultsBlock(store))),
      [],
      "neither a malformed nor a foreign failure produces a persistent line",
    );
  });
}

// ---- (h) a single (count-1) failure renders NO persistent line ----

test("F2 (h): a single (count-1) failure renders NO persistent line (only its fresh FAILED result that frame)", async () => {
  const { store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: false, error: "one-off" });

  const before = await renderMsgs(resultsBlock(store));
  assert.equal(before.length, 1, "the fresh failed result renders this frame");
  assert.match(String(before[0].content), /one-off/, "it is the fresh error entry");
  assert.deepEqual(failureLines(before), [], "no persistent line at count 1");

  emitLlmReturn(sys);
  assert.deepEqual(
    await renderMsgs(resultsBlock(store)),
    [],
    "a lone (count-1) failure leaves no persistent line after the return",
  );
});

// ---- teardown resets the ledger ----

test("F2: teardown resets the failure ledger (removing the block leaves nothing to render)", async () => {
  const { p, store, sys } = await setup({});
  emitToolResult(sys, { name: SEARCH, ok: false, error: "boom" });
  emitToolResult(sys, { name: SEARCH, ok: false, error: "boom" });
  emitLlmReturn(sys);
  assert.equal(failureLines(await renderMsgs(resultsBlock(store))).length, 1, "precondition: a persistent line exists");
  await p.teardown();
  assert.equal(store.get(RESULTS_BLOCK), undefined, "results block (with the folded ledger) is removed by teardown");
});
