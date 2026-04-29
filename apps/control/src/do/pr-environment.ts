/**
 * PrEnvironment DO — single-writer for the per-PR state machine (PRD §7.2).
 *
 * D1 row in `pr_environments` is the durable canonical record; this DO
 * serializes writes so two concurrent events for the same PR can't tear it.
 * Also holds an in-memory ring buffer of state-transition log lines for the
 * dashboard (Slice F connects WebSocket subscribers).
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.ts';
import type { PrEnvState } from '../lib/db/types.ts';
import { transitionState } from '../lib/db/prEnvironments.ts';
import { appendAudit } from '../lib/db/auditLog.ts';
import { ulid } from '../lib/ids.ts';
import { Logger } from '../lib/logger.ts';

interface LogLine {
  ts: number;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

const LOG_BUFFER_MAX = 500;

export class PrEnvironment extends DurableObject<Env> {
  private logBuffer: LogLine[] = [];

  async getState(): Promise<{ state: PrEnvState | null; reason: string | null }> {
    const prEnvId = (await this.ctx.storage.get<string>('prEnvId')) ?? null;
    if (!prEnvId) return { state: null, reason: null };
    const row = await this.env.DB.prepare(
      `SELECT state, state_reason FROM pr_environments WHERE id = ?`,
    )
      .bind(prEnvId)
      .first<{ state: PrEnvState; state_reason: string | null }>();
    return row ? { state: row.state, reason: row.state_reason } : { state: null, reason: null };
  }

  async transitionTo(
    prEnvId: string,
    state: PrEnvState,
    audit: { installationId: string; reason?: string },
  ): Promise<void> {
    const log = new Logger({ pr_env_id: prEnvId });
    await this.ctx.storage.put('prEnvId', prEnvId);
    const r = await transitionState(this.env.DB, prEnvId, state, audit.reason);
    if (!r.ok) {
      log.error('transition_failed', { state, err: String(r.error) });
      throw r.error;
    }
    this.appendLogLine({
      ts: Date.now(),
      level: 'info',
      msg: `state → ${state}${audit.reason ? ` (${audit.reason})` : ''}`,
    });
    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: audit.installationId,
      actor: 'system',
      action: `pr_env.${state}`,
      targetType: 'pr_environment',
      targetId: prEnvId,
      metadata: audit.reason ? { reason: audit.reason } : {},
    });
  }

  async appendLog(line: LogLine): Promise<void> {
    this.appendLogLine(line);
  }

  async tail(since = 0): Promise<{ lines: LogLine[]; cursor: number }> {
    const lines = this.logBuffer.filter((l) => l.ts > since);
    return { lines, cursor: this.logBuffer[this.logBuffer.length - 1]?.ts ?? since };
  }

  private appendLogLine(line: LogLine): void {
    this.logBuffer.push(line);
    if (this.logBuffer.length > LOG_BUFFER_MAX) {
      this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_MAX);
    }
  }
}
