/**
 * Structured logger (PRD §17).
 *
 * Design notes:
 *  - Workers Logs (with `observability.enabled: true`) captures `console.*` output.
 *    There is no separate sink in the Workers runtime, so the logger writes
 *    through `console`. The PRD §20 "no console.log" rule means *callers* must
 *    use this logger; the logger itself is the one place `console` is used.
 *  - Token redaction is applied to the serialized output, not the meta dict,
 *    so accidental token interpolation inside `msg` strings is also caught.
 */
import type { RaftEnvName } from '../env.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly request_id?: string;
  readonly env?: RaftEnvName;
  readonly installation_id?: string;
  readonly pr_env_id?: string;
  readonly [k: string]: unknown;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly base: LogFields;
  private readonly minLevel: LogLevel;

  constructor(base: LogFields = {}, minLevel: LogLevel = 'info') {
    this.base = base;
    this.minLevel = minLevel;
  }

  child(extra: LogFields): Logger {
    return new Logger({ ...this.base, ...extra }, this.minLevel);
  }

  debug(msg: string, meta?: LogFields): void {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: LogFields): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: LogFields): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: LogFields): void {
    this.write('error', msg, meta);
  }

  private write(level: LogLevel, msg: string, meta?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const entry = { ts: Date.now(), level, msg, ...this.base, ...(meta ?? {}) };
    const line = redact(safeStringify(entry));
    /* eslint-disable no-console -- the logger is the one allowed console caller */
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    /* eslint-enable no-console */
  }
}

// 40+ chars matches CF API tokens and GitHub PATs; UUIDs (36 chars) survive,
// preserving request_id traceability in logs.
const TOKEN_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;
const redact = (s: string): string =>
  s.replace(TOKEN_PATTERN, (m) => `<redacted:token:${m.slice(0, 6)}>`);

const safeStringify = (v: unknown): string => {
  try {
    return JSON.stringify(v);
  } catch {
    return JSON.stringify({ ts: Date.now(), level: 'error', msg: 'log_serialize_failed' });
  }
};
