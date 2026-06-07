/**
 * Shared: errors — common error types.
 */
export class OpenKrakeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A plugin's declared dependency (plugin id / action) is missing at load time. */
export class DependencyError extends OpenKrakeyError {}

/** A plugin module failed to load, parse, or validate. */
export class PluginLoadError extends OpenKrakeyError {}
