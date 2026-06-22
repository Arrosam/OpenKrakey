/**
 * inspector/config.ts — resolve the plugin's config slice into a validated shape.
 *
 * Split out of index.ts (SRP): the merge of nested-over-flat config plus the
 * numeric and token validation that used to sit inline at the top of setup().
 * Behaviour is unchanged — every fallback and the exact token charset/length
 * policy are preserved verbatim.
 */
import * as crypto from "node:crypto";
import type { PluginContext } from "../../contracts/plugin";

/**
 * Default loopback port. Deliberately distinct from web-chat's default (7718) so the
 * inspector never collides with it on a stock config. Single source of truth —
 * the port default belongs to config resolution, not the hub.
 */
const DEFAULT_PORT = 7719;

/** The fully-resolved, validated inspector configuration. */
interface InspectorConfig {
  port: number;
  host: string;
  token: string;
  bufferSize: number;
  maxRecordBytes: number;
}

/**
 * Resolve and validate this plugin's config slice. Accepts both a flat config and
 * a nested `inspector` key (nested wins). Numeric config is validated, not
 * trusted: a non-number (or non-positive size) falls back to the default rather
 * than poisoning listen()/the ring. The token must be a URL/cookie-safe string of
 * length ≥ 16; otherwise a fresh random token is generated.
 */
export function resolveConfig(ctx: PluginContext): InspectorConfig {
  const c = (ctx.config ?? {}) as any;
  const slice = {
    ...(typeof c === "object" ? c : {}),
    ...((c && c.inspector) || {}),
  };
  // Numeric config is validated, not trusted: a non-number (or non-positive
  // size) falls back to the default rather than poisoning listen()/the ring.
  const port: number = typeof slice.port === "number" ? slice.port : DEFAULT_PORT;
  const host: string = slice.host ?? "127.0.0.1";
  let token: string = slice.token ?? crypto.randomBytes(24).toString("base64url");
  // Reject a token that isn't a string, is too short to be a secret, or
  // contains anything outside the URL/cookie-safe charset.
  if (typeof token !== "string" || token.length < 16 || !/^[A-Za-z0-9._~+\/=-]+$/.test(token)) {
    token = crypto.randomBytes(24).toString("base64url");
  }
  const bufferSize: number =
    typeof slice.bufferSize === "number" && slice.bufferSize > 0 ? slice.bufferSize : 1000;
  const maxRecordBytes: number =
    typeof slice.maxRecordBytes === "number" && slice.maxRecordBytes > 0 ? slice.maxRecordBytes : 65536;

  return { port, host, token, bufferSize, maxRecordBytes };
}
