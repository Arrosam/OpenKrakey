/**
 * restart marker — a tiny on-disk breadcrumb the plugin drops just before it
 * asks the core to reboot the runtime, and reads back on the next boot. It is
 * how the fresh copy KNOWS it is the product of a restart the previous copy
 * requested, so it can tell the agent "the restart you asked for is done" once
 * (and never re-show it, never loop on it).
 *
 * PER-AGENT: `restart` is a PUBLIC plugin, so its dataDir is SHARED across every
 * agent that loads it. The marker filename therefore carries the agentId, so two
 * agents in one dataDir keep fully independent markers and never collide.
 *
 * PURE + best-effort: every filesystem op is swallowed. A missing, unreadable,
 * malformed, or shape-invalid marker is simply "no marker" — losing it only
 * means the completed-notice is skipped, never a crash. Only depends on node's
 * fs/path so tests can drive it directly.
 */
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface RestartMarker {
  /** When restart.now was called (Date.now()). */
  requestedAt: number;
  /** The reason the agent gave, or "" when none. */
  reason: string;
  /** false when written pre-restart; flipped to true once the notice is shown. */
  completed: boolean;
  /** The exact command that will relaunch this runtime (for reference only). */
  command?: string[];
}

/** Where this agent's marker file lives inside the plugin's (shared) dataDir. */
export function markerPath(dataDir: string, agentId: string): string {
  return join(dataDir, `restart-marker.${agentId}.json`);
}

/** Write this agent's marker, best-effort. Never throws. */
export function writeMarkerSync(dataDir: string, agentId: string, marker: RestartMarker): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(markerPath(dataDir, agentId), JSON.stringify(marker), "utf8");
  } catch {
    // best-effort: losing the marker only skips the completed notice.
  }
}

/**
 * Read this agent's marker back. Returns null on ANYTHING that isn't a well-shaped
 * marker: missing file, JSON parse error, non-object, or a bad field
 * (requestedAt must be a finite number, completed a boolean, reason a string).
 * `command`, when present, is passed through untouched.
 */
export function readMarker(dataDir: string, agentId: string): RestartMarker | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(markerPath(dataDir, agentId), "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const m = parsed as Record<string, unknown>;
  if (typeof m.requestedAt !== "number" || !Number.isFinite(m.requestedAt)) return null;
  if (typeof m.completed !== "boolean") return null;
  if (typeof m.reason !== "string") return null;
  return m as unknown as RestartMarker;
}

/** Delete this agent's marker, best-effort. A no-op when it is absent. Never throws. */
export function deleteMarker(dataDir: string, agentId: string): void {
  try {
    unlinkSync(markerPath(dataDir, agentId));
  } catch {
    // best-effort: absent (or unremovable) is fine.
  }
}
