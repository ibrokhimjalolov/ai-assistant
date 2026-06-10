export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type Meta = Record<string, unknown>;
type Sink = (line: string, level: Exclude<LogLevel, 'silent'>) => void;

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function initialLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || '').toLowerCase();
  if (env && env in ORDER) return env as LogLevel;
  if (process.env.VITEST) return 'silent'; // keep test output clean
  return 'info';
}

let minLevel: LogLevel = initialLevel();

const defaultSink: Sink = (line, level) => {
  const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
  stream.write(line + '\n');
};
let sink: Sink = defaultSink;

/** Override the minimum level (e.g. for tests or LOG_LEVEL changes). */
export function setLevel(level: LogLevel): void { minLevel = level; }
/** Override the output sink (for tests). */
export function setSink(s: Sink): void { sink = s; }

function emit(level: Exclude<LogLevel, 'silent'>, component: string, msg: string, meta?: Meta): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const ts = new Date().toISOString();
  const tag = component ? `[${component}] ` : '';
  const body = meta && Object.keys(meta).length ? `${msg} ${JSON.stringify(meta)}` : msg;
  sink(`${ts} ${level.toUpperCase().padEnd(5)} ${tag}${body}`, level);
}

export interface Logger {
  debug(msg: string, meta?: Meta): void;
  info(msg: string, meta?: Meta): void;
  warn(msg: string, meta?: Meta): void;
  error(msg: string, meta?: Meta): void;
  child(sub: string): Logger;
}

export function logger(component = ''): Logger {
  return {
    debug: (m, meta) => emit('debug', component, m, meta),
    info: (m, meta) => emit('info', component, m, meta),
    warn: (m, meta) => emit('warn', component, m, meta),
    error: (m, meta) => emit('error', component, m, meta),
    child: (sub) => logger(component ? `${component}.${sub}` : sub),
  };
}
