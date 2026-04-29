/**
 * raft-tail-events queue consumer.
 *
 * Each message carries a batch of trace events emitted by one user worker.
 * We resolve `scriptName` → `prEnvId` via the ROUTES KV reverse index, then
 * fan the events out to the per-PR LogTail DO for hibernatable-WebSocket
 * delivery to dashboard subscribers.
 */
import type { Env, TailEvent } from '../env.ts';
import { Logger } from '../lib/logger.ts';
import type { LogTail, LogEvent } from '../do/log-tail.ts';

const REVERSE_INDEX_KEY = (script: string): string => `script:${script}:pr`;

const pickLevel = (lvl: string | undefined): 'info' | 'warn' | 'error' =>
  lvl === 'warn' || lvl === 'error' ? lvl : 'info';

const traceItemToLogEvent = (scriptName: string, item: unknown): LogEvent => {
  const t = item as { eventTimestamp?: number; logs?: { level?: string; message?: unknown[] }[] };
  const ts = typeof t.eventTimestamp === 'number' ? t.eventTimestamp : Date.now();
  const firstLog = t.logs?.[0];
  return {
    ts,
    scriptName,
    level: pickLevel(firstLog?.level),
    msg: firstLog ? String(firstLog.message?.join(' ') ?? '') : 'trace',
    meta: { raw: t },
  };
};

export const handleTailQueueBatch = async (
  batch: MessageBatch<TailEvent>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> => {
  const log = new Logger({ component: 'tail-consumer' });
  for (const msg of batch.messages) {
    try {
      const { scriptName, events } = msg.body;
      const prEnvId =
        msg.body.prEnvId ?? (await env.ROUTES.get(REVERSE_INDEX_KEY(scriptName)));
      if (!prEnvId) {
        log.warn('tail_no_pr_env', { script: scriptName });
        msg.ack();
        continue;
      }
      const stub = env.LOGTAIL.get(env.LOGTAIL.idFromName(prEnvId)) as DurableObjectStub<LogTail>;
      for (const item of events) {
        await stub.append(traceItemToLogEvent(scriptName, item));
      }
      msg.ack();
    } catch (e) {
      log.error('tail_batch_failed', { err: String(e) });
      msg.retry();
    }
  }
};
