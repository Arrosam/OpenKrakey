import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  ensureSurfaceTokens,
  surfaceUrl,
  isValidSurfaceToken,
  type SurfaceInfo,
} from "../packages/cli/src/surfaces";

// ---------------------------------------------------------------------------
// Edge tests for cli/surfaces — the B2 dashboard-token fix. ensureSurfaceTokens
// pins a STABLE token into the agent config for the runtime's framed surfaces
// (web-chat / inspector) so `krakey dashboard` can authenticate them; surfaceUrl
// builds the tokened loopback URL the Console frames.
// ---------------------------------------------------------------------------

/** A throwaway agents/ tree; returns its path and a writer for agent configs. */
function tmpAgents(t: { after(fn: () => void): void }): {
  agentsDir: string;
  writeAgent(id: string, def: unknown): string;
  readAgent(id: string): any;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "krakey-surfaces-"));
  const agentsDir = path.join(root, "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return {
    agentsDir,
    writeAgent(id, def) {
      const dir = path.join(agentsDir, id);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, "config.json");
      fs.writeFileSync(p, JSON.stringify(def, null, 2) + "\n", "utf8");
      return p;
    },
    readAgent(id) {
      return JSON.parse(fs.readFileSync(path.join(agentsDir, id, "config.json"), "utf8"));
    },
  };
}

// ===========================================================================
// isValidSurfaceToken — mirrors the web-chat / inspector acceptance policy
// ===========================================================================

test("isValidSurfaceToken: a base64url string of length ≥16 is accepted", () => {
  assert.equal(isValidSurfaceToken("abcdefghijklmnop"), true, "16 safe chars is the boundary");
  assert.equal(isValidSurfaceToken("A1_b2-c3.d4~e5=f6+g7/h8"), true, "the full safe charset is allowed");
});

test("isValidSurfaceToken: too-short, bad-charset, or non-string tokens are rejected", () => {
  assert.equal(isValidSurfaceToken("short"), false, "length < 16 rejected");
  assert.equal(isValidSurfaceToken("has spaces in it here"), false, "space is outside the charset");
  assert.equal(isValidSurfaceToken("contains#hash#chars!!"), false, "# / ! are outside the charset");
  assert.equal(isValidSurfaceToken(undefined), false);
  assert.equal(isValidSurfaceToken(12345678901234567), false, "a number is not a token");
});

// ===========================================================================
// surfaceUrl — tokened loopback URL, or bare URL when the token is unknown
// ===========================================================================

test("surfaceUrl: with a SurfaceInfo, builds a loopback URL carrying ?token=", () => {
  const info: SurfaceInfo = { port: 7718, token: "tok_ABCDEFGHIJKL" };
  assert.equal(surfaceUrl(info, 7718), "http://127.0.0.1:7718/?token=tok_ABCDEFGHIJKL");
});

test("surfaceUrl: a configured non-default port is honoured", () => {
  assert.equal(surfaceUrl({ port: 9001, token: "tok_ABCDEFGHIJKL" }, 7718), "http://127.0.0.1:9001/?token=tok_ABCDEFGHIJKL");
});

test("surfaceUrl: undefined info falls back to the bare default-port URL (pre-fix behaviour)", () => {
  assert.equal(surfaceUrl(undefined, 7719), "http://127.0.0.1:7719");
});

test("surfaceUrl: the token is URL-encoded", () => {
  // base64url never needs encoding, but the standard `=`/`+`/`/` charset does.
  const url = surfaceUrl({ port: 7718, token: "a+b/c=dddddddddddd" }, 7718);
  assert.ok(url.includes("token=a%2Bb%2Fc%3Ddddddddddddd"), `expected encoded token, got ${url}`);
});

// ===========================================================================
// ensureSurfaceTokens — mint + persist + read back
// ===========================================================================

test("ensureSurfaceTokens: mints and PERSISTS a token for web-chat and inspector", (t) => {
  const fx = tmpAgents(t);
  fx.writeAgent("krakey", {
    id: "krakey",
    plugins: ["llm-core", "web-chat"],
    privatePlugins: ["inspector"],
    config: {},
  });

  const out = ensureSurfaceTokens(fx.agentsDir);

  assert.ok(out.chat, "web-chat surface resolved");
  assert.ok(out.inspector, "inspector surface resolved");
  assert.ok(isValidSurfaceToken(out.chat!.token), "minted chat token is valid");
  assert.ok(isValidSurfaceToken(out.inspector!.token), "minted inspector token is valid");
  assert.equal(out.chat!.port, 7718, "default web-chat port");
  assert.equal(out.inspector!.port, 7719, "default inspector port");

  // The token was written back so the runtime reads the SAME one at boot.
  const def = fx.readAgent("krakey");
  assert.equal(def.config["web-chat"].token, out.chat!.token, "chat token persisted to config");
  assert.equal(def.config["inspector"].token, out.inspector!.token, "inspector token persisted to config");
});

test("ensureSurfaceTokens: an already-valid token is PRESERVED (idempotent, file not changed)", (t) => {
  const fx = tmpAgents(t);
  const pinned = "PINNEDtoken_abcdefghijklmnop";
  const p = fx.writeAgent("krakey", {
    id: "krakey",
    plugins: ["web-chat"],
    config: { "web-chat": { port: 7718, token: pinned } },
  });
  const before = fs.readFileSync(p, "utf8");

  const out = ensureSurfaceTokens(fx.agentsDir);

  assert.equal(out.chat!.token, pinned, "the existing valid token is returned unchanged");
  assert.equal(fs.readFileSync(p, "utf8"), before, "the config file is NOT rewritten when the token is already valid");
});

test("ensureSurfaceTokens: an INVALID configured token is replaced", (t) => {
  const fx = tmpAgents(t);
  fx.writeAgent("krakey", {
    id: "krakey",
    plugins: ["web-chat"],
    config: { "web-chat": { token: "short" } }, // too short → not adopted by the plugin
  });

  const out = ensureSurfaceTokens(fx.agentsDir);

  assert.ok(isValidSurfaceToken(out.chat!.token), "a fresh valid token replaces the invalid one");
  assert.notEqual(out.chat!.token, "short");
  assert.equal(fx.readAgent("krakey").config["web-chat"].token, out.chat!.token, "the replacement is persisted");
});

test("ensureSurfaceTokens: agents that don't enable a surface are skipped", (t) => {
  const fx = tmpAgents(t);
  fx.writeAgent("plain", { id: "plain", plugins: ["llm-core", "persona"], config: {} });

  const out = ensureSurfaceTokens(fx.agentsDir);

  assert.equal(out.chat, undefined, "no web-chat anywhere → no chat surface");
  assert.equal(out.inspector, undefined, "no inspector anywhere → no inspector surface");
  assert.equal(fx.readAgent("plain").config["web-chat"], undefined, "a non-enabling agent's config is untouched");
});

test("ensureSurfaceTokens: only the FIRST (readdir-order) enabling agent is pinned — the one that wins the port bind", (t) => {
  const fx = tmpAgents(t);
  fx.writeAgent("a", { id: "a", plugins: ["web-chat"], config: {} });
  fx.writeAgent("b", { id: "b", plugins: ["web-chat"], config: {} });

  // Whichever the runtime would start first (same readdir order boot uses).
  const firstId = fs
    .readdirSync(fx.agentsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)[0];
  const secondId = firstId === "a" ? "b" : "a";

  const out = ensureSurfaceTokens(fx.agentsDir);

  assert.ok(out.chat, "chat surface resolved");
  assert.equal(
    fx.readAgent(firstId).config["web-chat"].token,
    out.chat!.token,
    "the first enabling agent's token is the one returned (it wins the port bind)",
  );
  assert.equal(
    fx.readAgent(secondId).config["web-chat"],
    undefined,
    "the second enabling agent is left untouched (its server would just reuse the first's)",
  );
});

test("ensureSurfaceTokens: honours a configured non-default port", (t) => {
  const fx = tmpAgents(t);
  fx.writeAgent("krakey", {
    id: "krakey",
    plugins: ["web-chat", "inspector"],
    config: { "web-chat": { port: 9001 }, inspector: { port: 9002 } },
  });

  const out = ensureSurfaceTokens(fx.agentsDir);

  assert.equal(out.chat!.port, 9001, "configured web-chat port is reported");
  assert.equal(out.inspector!.port, 9002, "configured inspector port is reported");
});

test("ensureSurfaceTokens: a private-plugin surface is still recognised", (t) => {
  const fx = tmpAgents(t);
  fx.writeAgent("krakey", {
    id: "krakey",
    plugins: ["llm-core"],
    privatePlugins: ["web-chat"], // enabled only via privatePlugins
    config: {},
  });

  const out = ensureSurfaceTokens(fx.agentsDir);
  assert.ok(out.chat, "web-chat listed under privatePlugins still counts as enabled");
  assert.ok(isValidSurfaceToken(out.chat!.token));
});

test("ensureSurfaceTokens: a missing agents dir returns {} without throwing", () => {
  const out = ensureSurfaceTokens(path.join(os.tmpdir(), "krakey-does-not-exist-" + process.pid));
  assert.deepEqual(out, {}, "no agents dir → no surfaces, no throw");
});

test("ensureSurfaceTokens: a garbled config file is skipped, not fatal", (t) => {
  const fx = tmpAgents(t);
  const dir = path.join(fx.agentsDir, "broken");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), "{ this is not json", "utf8");
  // plus a good agent that DOES enable web-chat
  fx.writeAgent("good", { id: "good", plugins: ["web-chat"], config: {} });

  const out = ensureSurfaceTokens(fx.agentsDir);
  assert.ok(out.chat, "the good agent's surface still resolves despite a sibling garbled config");
});
