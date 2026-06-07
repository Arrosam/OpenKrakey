/**
 * Shared: logging — minimal logger interface + console impl.
 */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[error] ${m}`),
};

/** Prefix a logger's lines with a tag (e.g. an agent id or plugin id). */
export function tagged(logger: Logger, tag: string): Logger {
  return {
    info: (m) => logger.info(`${tag} ${m}`),
    warn: (m) => logger.warn(`${tag} ${m}`),
    error: (m) => logger.error(`${tag} ${m}`),
  };
}
