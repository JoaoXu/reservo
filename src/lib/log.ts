// Structured JSON logs on stdout: picked up as-is by CloudWatch and Cloud Logging.
import { config } from '../config.ts';

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const threshold = levels[(config.logLevel as Level)] ?? levels.info;

// Never log these fields, even if passed by mistake.
const redact = new Set(['password', 'mbKey', 'mbwayKey', 'antiPhishingKey', 'token', 'key', 'authorization', 'cookie']);

function clean(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (redact.has(k)) out[k] = '[redacted]';
    else if (v instanceof Error) out[k] = { message: v.message, stack: v.stack, code: (v as { code?: unknown }).code };
    else out[k] = v;
  }
  return out;
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (levels[level] < threshold) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, severity: level.toUpperCase(), msg, ...clean(fields) });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f),
};
