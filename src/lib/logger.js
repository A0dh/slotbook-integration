// A small structured logger: one JSON object per line.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {string} [level] minimum level to write: debug | info | warn | error
 * @param {(line: string) => void} [write]
 */
export function createLogger(level = 'info', write = (line) => process.stdout.write(`${line}\n`)) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const at = (name) => (message, fields = {}) => {
    if (LEVELS[name] < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: name, message, ...fields }));
  };

  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

/** @typedef {ReturnType<typeof createLogger>} Logger */

export const logger = createLogger(process.env.LOG_LEVEL);
