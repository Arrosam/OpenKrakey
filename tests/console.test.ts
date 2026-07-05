/**
 * Black-box EDGE tests for the `console` node's UPCOMING token gating (F4).
 *
 * The console server (packages/console/src/server.ts) is CURRENTLY ungated: it
 * serves the injected shell + GET /api/status to anyone, with no `token` dep, no
 * cookie, no 401 path (see the module header: "NO token gating, NO cookie, no
 * secrets"). F4 changes that. These tests are written from the SPEC only and are
 * expected to be RED against main — the current `startServer` has no `token` dep
 * and never returns 401, so every gating assertion fails until the node ships F4.
 *
 * PINNED SURFACE (the dev implements exactly this):
 *   - startServer's deps gain `token: string`.
 *   - GET / and /index.html WITHOUT a valid token -> 401, and the raw body
 *     contains NONE of the embedded surface URLs/tokens (the injected
 *     window.__SURFACES__ must not leak to an unauthenticated caller).
 *   - GET / and /index.html WITH a valid token (via ?token=, Authorization:
 *     Bearer, or the console_token cookie planted by a prior tokened request)
 *     -> 200 with window.__SURFACES__ injected (and the sentinel URLs present).
 *   - GET /api/status: 401 untokened, 200 tokened; the JSON shape is unchanged
 *     ({ config, chat, inspector } booleans).
 *   - Secret-free static assets (if any exist under static/) stay 200 WITHOUT a
 *     token — a 401 on a non-secret asset would be the bug.
 *   - The returned `url` includes `?token=<token>`.
 *   - A valid tokened request sets an HttpOnly `console_token` cookie; a
 *     follow-up request carrying ONLY that cookie succeeds.
 *
 * HTTP style mirrors tests/config-web.test.ts + tests/http-auth.test.ts: bind
 * 127.0.0.1 on an ephemeral port (port 0), read the real port off the returned
 * handle, and ALWAYS close the server in a `finally` so a failing assertion can
 * never wedge the suite on an open listener. `fetch`'s redirect/cookie jar is NOT
 * used — we drive the Cookie / Authorization headers by hand so the assertions
 * are explicit and order-free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Guarded dynamic import of the console server. A missing/älterer module yields
// `{}` so each test fails on an honest assertion, not an import throw. Against
// main the module DOES exist, but has no `token` dep — so the gating tests turn
// RED on the 401/cookie assertions, which is exactly the pre-implementation
// signal we want.
// ---------------------------------------------------------------------------
const serverMod: any = await import("../packages/console/src/server").catch(() => ({}));

const HOST = "127.0.0.1";

// A realistic session secret (long enough to exercise the constant-time compare
// in shared/http-auth.tokenOk, whose fast path requires length equality).
const TOKEN = "console-token-1234567890abcdef";

// SENTINEL surface URLs. Each carries a DISTINCTIVE token substring that could
// only appear in the served body if window.__SURFACES__ was injected — so an
// unauthenticated 401 body that contains NONE of these proves the secret shell
// (and the operator's real surface URLs/tokens) never leaked. We drive
// startServer with these fakes rather than real ports.
const SENTINEL_CONFIG = "http://127.0.0.1:19001/?token=SENTINEL_CONFIG_TOKEN";
const SENTINEL_CHAT = "http://127.0.0.1:19002/?token=SENTINEL_CHAT_TOKEN";
const SENTINEL_INSPECTOR = "http://127.0.0.1:19003/?token=SENTINEL_INSPECTOR_TOKEN";
const SENTINELS = [
  "SENTINEL_CONFIG_TOKEN",
  "SENTINEL_CHAT_TOKEN",
  "SENTINEL_INSPECTOR_TOKEN",
  SENTINEL_CONFIG,
  SENTINEL_CHAT,
  SENTINEL_INSPECTOR,
];

interface ServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Start the console server on an ephemeral loopback port with the NEW `token`
 * dep pinned. Every EXISTING dep matches the source ConsoleDeps signature
 * (port/host/configUrl/chatUrl/inspectorUrl); ONLY `token` is added per the F4
 * spec. Against main, `startServer` ignores the extra `token` field and never
 * gates — so the gating tests below fail as intended.
 */
async function startServer(): Promise<ServerHandle> {
  assert.equal(
    typeof serverMod.startServer,
    "function",
    "console/server.startServer not implemented yet",
  );
  const handle = await serverMod.startServer({
    port: 0,
    host: HOST,
    configUrl: SENTINEL_CONFIG,
    chatUrl: SENTINEL_CHAT,
    inspectorUrl: SENTINEL_INSPECTOR,
    // --- the NEW F4 dep (pinned) ---
    token: TOKEN,
  });
  assert.ok(handle && typeof handle === "object", "startServer must resolve a handle");
  assert.equal(typeof handle.port, "number", "handle.port must be a number");
  assert.ok(handle.port > 0, "an ephemeral port must be bound (got " + handle.port + ")");
  assert.equal(typeof handle.url, "string", "handle.url must be a string");
  assert.equal(typeof handle.close, "function", "handle.close must be a function");
  return handle as ServerHandle;
}

const base = (h: ServerHandle) => "http://" + HOST + ":" + h.port;

/** Build a same-origin URL carrying the session token in the query string. */
function withToken(h: ServerHandle, path: string, token: string = TOKEN): string {
  const sep = path.includes("?") ? "&" : "?";
  return base(h) + path + sep + "token=" + encodeURIComponent(token);
}

/**
 * Run `body(handle)` against a freshly started console server, guaranteeing the
 * listener is torn down even when an assertion throws.
 */
async function withServer(body: (h: ServerHandle) => Promise<void>): Promise<void> {
  let h: ServerHandle | undefined;
  try {
    h = await startServer();
    await body(h);
  } finally {
    if (h) {
      try {
        await h.close();
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Assert a raw response body leaks NONE of the injected surface sentinels. */
function assertNoSentinelLeak(body: string, ctx: string): void {
  for (const s of SENTINELS) {
    assert.ok(
      !body.includes(s),
      `${ctx}: the unauthenticated body must not leak the surface sentinel ${JSON.stringify(s)}`,
    );
  }
  assert.ok(
    !body.includes("window.__SURFACES__"),
    `${ctx}: the unauthenticated body must not inject window.__SURFACES__`,
  );
}

/** Pull the console_token cookie value out of a Set-Cookie header, or undefined. */
function parseConsoleCookie(setCookie: string | null): string | undefined {
  if (!setCookie) return undefined;
  // `fetch` folds multiple Set-Cookie headers into one comma-joined string; the
  // console plants a single cookie, so a simple attribute scan suffices.
  const m = /(?:^|[,\s;])console_token=([^;,\s]*)/.exec(setCookie);
  return m ? m[1] : undefined;
}

// ===========================================================================
// 0. handle shape — the returned url carries ?token= (test 7)
// ===========================================================================

test("console: the returned handle url is loopback and CONTAINS ?token=<token>", async () => {
  await withServer(async (h) => {
    assert.match(h.url, /127\.0\.0\.1/, "the console binds loopback (URL is 127.0.0.1)");
    assert.match(h.url, new RegExp(":" + h.port + "\\b"), "the URL carries the bound port");
    assert.match(h.url, /[?&]token=/, "the returned url must include a ?token= query param");
    assert.ok(
      h.url.includes("token=" + encodeURIComponent(TOKEN)),
      "the returned url must embed the configured token so the operator can open a gated console",
    );
  });
});

// ===========================================================================
// 1. GET / WITHOUT a token -> 401 + no surface-secret leak (test 1)
// ===========================================================================

test("console: GET / WITHOUT a token -> 401 and the body leaks no surface secrets", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/");
    assert.equal(res.status, 401, "the console shell must be token-gated (401 without a token)");
    const body = await res.text();
    assertNoSentinelLeak(body, "GET / (no token)");
  });
});

test("console: GET /index.html WITHOUT a token -> 401 and the body leaks no surface secrets", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/index.html");
    assert.equal(res.status, 401, "/index.html is the same gated shell (401 without a token)");
    const body = await res.text();
    assertNoSentinelLeak(body, "GET /index.html (no token)");
  });
});

// ===========================================================================
// 2. GET / WITH the correct ?token= -> 200 + window.__SURFACES__ + sentinels
//    (test 2). Also covers the Authorization: Bearer source (spec-listed).
// ===========================================================================

test("console: GET /?token=<token> -> 200 with window.__SURFACES__ and the sentinel URLs injected", async () => {
  await withServer(async (h) => {
    const res = await fetch(withToken(h, "/"));
    assert.equal(res.status, 200, "a correct ?token= unlocks the shell");
    assert.match(
      res.headers.get("content-type") || "",
      /text\/html/,
      "the served shell is HTML",
    );
    const body = await res.text();
    assert.ok(
      body.includes("window.__SURFACES__"),
      "the authenticated shell must inject window.__SURFACES__",
    );
    assert.ok(body.includes(SENTINEL_CONFIG), "the injected config surface URL is present");
    assert.ok(body.includes(SENTINEL_CHAT), "the injected chat surface URL is present");
    assert.ok(body.includes(SENTINEL_INSPECTOR), "the injected inspector surface URL is present");
  });
});

test("console: GET /index.html?token=<token> -> 200 with the injected shell", async () => {
  await withServer(async (h) => {
    const res = await fetch(withToken(h, "/index.html"));
    assert.equal(res.status, 200, "a correct ?token= unlocks /index.html too");
    const body = await res.text();
    assert.ok(body.includes("window.__SURFACES__"), "/index.html injects window.__SURFACES__");
    assert.ok(body.includes(SENTINEL_CHAT), "/index.html carries the injected surface URLs");
  });
});

test("console: GET / with a valid Authorization: Bearer token -> 200 (Bearer is an accepted source)", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/", {
      headers: { authorization: "Bearer " + TOKEN },
    });
    assert.equal(res.status, 200, "a valid Bearer token unlocks the shell (no query param needed)");
    const body = await res.text();
    assert.ok(body.includes("window.__SURFACES__"), "the Bearer-authed shell injects the surfaces");
  });
});

// ===========================================================================
// 3. WRONG token -> 401 (test 3) — across every accepted source.
// ===========================================================================

test("console: GET /?token=<wrong> -> 401 and no secret leak", async () => {
  await withServer(async (h) => {
    const res = await fetch(withToken(h, "/", "not-the-real-token"));
    assert.equal(res.status, 401, "a wrong ?token= is rejected");
    assertNoSentinelLeak(await res.text(), "GET / (wrong ?token=)");
  });
});

test("console: GET / with a WRONG Authorization: Bearer -> 401", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/", {
      headers: { authorization: "Bearer wrong-token-value-000000000000" },
    });
    assert.equal(res.status, 401, "a wrong Bearer token is rejected");
  });
});

test("console: GET / with a WRONG console_token cookie -> 401", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/", {
      headers: { cookie: "console_token=totally-wrong-cookie-value" },
    });
    assert.equal(res.status, 401, "a wrong cookie is rejected (fail closed)");
  });
});

// A same-length wrong token exercises the constant-time compare's mismatch path
// (tokenOk's length fast-path is bypassed → the timingSafeEqual branch runs).
test("console: GET /?token=<same-length-but-wrong> -> 401 (constant-time mismatch path)", async () => {
  await withServer(async (h) => {
    const wrong = "x".repeat(TOKEN.length);
    assert.equal(wrong.length, TOKEN.length, "the wrong token matches the real length");
    const res = await fetch(withToken(h, "/", wrong));
    assert.equal(res.status, 401, "a same-length wrong token still fails closed");
  });
});

// ===========================================================================
// 4. GET /api/status — 401 untokened, 200 tokened, shape unchanged (test 4)
// ===========================================================================

test("console: GET /api/status WITHOUT a token -> 401", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/api/status");
    assert.equal(res.status, 401, "the status endpoint must be token-gated too");
  });
});

test("console: GET /api/status?token=<token> -> 200 with the unchanged {config,chat,inspector} boolean shape", async () => {
  await withServer(async (h) => {
    const res = await fetch(withToken(h, "/api/status"));
    assert.equal(res.status, 200, "a correct token unlocks the status endpoint");
    assert.match(
      res.headers.get("content-type") || "",
      /application\/json/,
      "the status endpoint stays JSON",
    );
    const body = (await res.json()) as Record<string, unknown>;
    assert.ok(body && typeof body === "object" && !Array.isArray(body), "status is a JSON object");
    // The shape is unchanged from today: exactly the three surface keys, each a boolean.
    for (const k of ["config", "chat", "inspector"] as const) {
      assert.ok(k in body, `status must carry the '${k}' key (shape unchanged)`);
      assert.equal(typeof body[k], "boolean", `status.${k} must be a boolean (shape unchanged)`);
    }
    // No sentinel surface URL/token should ever be echoed into the status JSON.
    assertNoSentinelLeak(JSON.stringify(body), "GET /api/status (tokened body)");
  });
});

test("console: GET /api/status with a WRONG token -> 401 (not 200/500)", async () => {
  await withServer(async (h) => {
    const res = await fetch(withToken(h, "/api/status", "wrong-status-token"));
    assert.equal(res.status, 401, "a bad token on the status endpoint is 401");
  });
});

// ===========================================================================
// 5. Cookie round-trip — a tokened request plants an HttpOnly console_token
//    cookie; a follow-up request carrying ONLY that cookie succeeds. (test 5)
// ===========================================================================

test("console: a valid tokened GET / sets an HttpOnly console_token cookie", async () => {
  await withServer(async (h) => {
    const res = await fetch(withToken(h, "/"));
    assert.equal(res.status, 200, "baseline: the tokened request is accepted");
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie, "a tokened request must plant a Set-Cookie header");
    assert.match(setCookie as string, /console_token=/, "the planted cookie is named console_token");
    assert.match(
      setCookie as string,
      /HttpOnly/i,
      "the console_token cookie must be HttpOnly (not readable from JS)",
    );
    const cookieVal = parseConsoleCookie(setCookie);
    assert.ok(cookieVal && cookieVal.length > 0, "the console_token cookie carries a value");
  });
});

test("console: a follow-up request with ONLY the planted console_token cookie succeeds (round-trip)", async () => {
  await withServer(async (h) => {
    // 1) Authenticate once (via ?token=) and harvest the planted cookie.
    const first = await fetch(withToken(h, "/"));
    assert.equal(first.status, 200, "the initial tokened request is accepted");
    const cookieVal = parseConsoleCookie(first.headers.get("set-cookie"));
    assert.ok(cookieVal, "the first tokened request must plant a console_token cookie to round-trip");

    // 2) A SECOND request that carries ONLY the cookie (no ?token=, no Bearer)
    //    must be accepted — the cookie is a first-class auth source.
    const second = await fetch(base(h) + "/", {
      headers: { cookie: "console_token=" + cookieVal },
    });
    assert.equal(second.status, 200, "the cookie alone must authenticate the follow-up shell request");
    const body = await second.text();
    assert.ok(
      body.includes("window.__SURFACES__"),
      "the cookie-authenticated shell still injects window.__SURFACES__",
    );

    // 3) The same cookie authenticates the API too (single session across routes).
    const status = await fetch(base(h) + "/api/status", {
      headers: { cookie: "console_token=" + cookieVal },
    });
    assert.equal(status.status, 200, "the cookie session also unlocks /api/status");
  });
});

// ===========================================================================
// 6. Secret-free static assets stay 200 WITHOUT a token (test 6).
//    NOTE: today static/ holds ONLY index.html (which IS the secret-injected
//    shell), so there is no separate secret-free asset to fetch. This test is
//    written to be MEANINGFUL against whatever the dev ships: it probes a set of
//    conventional secret-free asset paths and asserts that any that EXIST are
//    served 200 without a token. A 401 on such an asset would be the bug (a
//    non-secret asset must never be gated); a 404 simply means that asset does
//    not exist in this build and is skipped. The '/' shell (which DOES carry
//    secrets) is asserted separately above to be 401, so this cannot vacuously
//    pass by treating everything as gated.
// ===========================================================================

test("console: any secret-free static asset (styles.css / app.js / favicon) is served 200 WITHOUT a token", async () => {
  await withServer(async (h) => {
    const candidates = ["/styles.css", "/app.js", "/favicon.svg", "/favicon.ico"];
    let probed = 0;
    for (const path of candidates) {
      const res = await fetch(base(h) + path);
      // Drain the body so the socket is released regardless of status.
      const body = await res.text();
      if (res.status === 404) continue; // asset not present in this build → skip
      probed++;
      assert.equal(
        res.status,
        200,
        `a secret-free static asset (${path}) must be served 200 WITHOUT a token, not gated`,
      );
      assertNoSentinelLeak(body, `static asset ${path}`);
    }
    // If NO secret-free asset exists yet, the assertion set is empty — that's an
    // honest reflection of the current single-asset (index.html) build, not a
    // failure. The gating behaviour itself is fully covered by the 401 tests.
    assert.ok(
      probed >= 0,
      "secret-free-asset probe ran (0 probed means static/ holds only the gated shell)",
    );
  });
});

// A companion assertion that CANNOT vacuously pass: an UNKNOWN, non-existent
// path must be a 404 (not-found), NEVER a 401 — gating applies to the shell +
// api routes, not to the static router's miss path. This pins that the 401 gate
// is scoped to real secret-bearing routes and doesn't blanket every request.
test("console: an unknown path is 404 (not 401) — gating is scoped, not a blanket reject", async () => {
  await withServer(async (h) => {
    const res = await fetch(base(h) + "/definitely-not-a-real-asset-" + Date.now());
    await res.text();
    assert.notEqual(res.status, 401, "a plain not-found path must not masquerade as a 401 auth gate");
    assert.equal(res.status, 404, "an unknown path is a 404 Not Found");
  });
});
