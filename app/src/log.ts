import type { Logger } from './types.ts';

const level = (process.env.LOG_LEVEL ?? 'info').toLowerCase();

function emit(lvl: string, msg: string, data?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...data });
  if (lvl === 'warn') console.error(line);
  else console.log(line);
}

export const log: Logger = {
  info: (m, d) => emit('info', m, d),
  warn: (m, d) => emit('warn', m, d),
  debug: (m, d) => {
    if (level === 'debug') emit('debug', m, d);
  },
};

/** A logger that records instead of printing; for tests. */
export function memoryLogger(): Logger & { lines: { lvl: string; msg: string; data?: Record<string, unknown> }[] } {
  const lines: { lvl: string; msg: string; data?: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (msg, data) => lines.push({ lvl: 'info', msg, data }),
    warn: (msg, data) => lines.push({ lvl: 'warn', msg, data }),
    debug: (msg, data) => lines.push({ lvl: 'debug', msg, data }),
  };
}
