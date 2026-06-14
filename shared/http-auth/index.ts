/**
 * Shared: http-auth — the per-process session-token primitives shared by the
 * loopback HTTP plugins (web, inspector).
 *
 * Only the security-critical, byte-identical pieces live here: the constant-time
 * token comparison and the three token-source extractors. Each plugin keeps its
 * OWN source precedence and its own token-from-config policy at the call site —
 * those legitimately differ (e.g. web reads its cookie raw and is open when no
 * token is set; inspector decodes its cookie and is closed), so they are NOT
 * hoisted here. The two behavioural knobs that differ are explicit parameters
 * (`openWhenUnset`, `decode`) so sharing this code changes no plugin's behaviour.
 *
 * R2 is untouched: this is a shared module (like shared/actions), not a
 * plugin-to-plugin import.
 */
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

/** A `Authorization: Bearer <token>` header value, or undefined. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const auth = req.headers["authorization"];
  if (typeof auth === "string" && auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();
  return undefined;
}

/** The `?token=` query parameter, or undefined. */
export function queryToken(params: URLSearchParams): string | undefined {
  return params.get("token") ?? undefined;
}

/**
 * The value of the named cookie, or undefined. `decode` (default true) runs
 * `decodeURIComponent` and fails CLOSED on a malformed `%`-escape so an
 * unauthenticated caller can never crash the process; pass `decode: false` to
 * read the cookie value verbatim (web sets its cookie unencoded).
 */
export function cookieToken(
  req: IncomingMessage,
  name: string,
  opts?: { decode?: boolean },
): string | undefined {
  const cookie = req.headers["cookie"];
  if (typeof cookie !== "string") return undefined;
  const decode = opts?.decode ?? true;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!decode) return raw;
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Constant-time check that `provided` matches `expected`. Unequal lengths (and a
 * non-string `provided`) fail closed without a timing-revealing compare. When no
 * token is configured (`expected` empty), the result is `openWhenUnset` — web
 * passes true (open), inspector passes false (closed).
 */
export function tokenOk(
  provided: string | undefined,
  expected: string,
  opts?: { openWhenUnset?: boolean },
): boolean {
  if (!expected) return opts?.openWhenUnset === true;
  if (typeof provided !== "string" || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}
