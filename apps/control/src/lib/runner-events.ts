/**
 * Push runner step events into the per-PR LogTail DO so dashboard tabs
 * subscribed over the hibernatable WebSocket see progress live instead of
 * polling. Best-effort: a failure here must never fail a step.
 */
import type { Env } from '../env.ts';
import type { LogTail } from '../do/log-tail.ts';

export interface RunnerEvent {
  runner: 'provision' | 'teardown';
  step: string;
  status: 'started' | 'ok' | 'retry' | 'failed' | 'succeeded';
  cursor?: number;
  attempt?: number;
  message?: string;
  durationMs?: number;
}

export const emitRunnerEvent = async (
  env: Env,
  prEnvId: string,
  ev: RunnerEvent,
): Promise<void> => {
  try {
    const stub = env.LOGTAIL.get(env.LOGTAIL.idFromName(prEnvId)) as DurableObjectStub<LogTail>;
    await stub.append({
      ts: Date.now(),
      level: ev.status === 'failed' ? 'error' : ev.status === 'retry' ? 'warn' : 'info',
      msg: `${ev.runner}:${ev.step}:${ev.status}`,
      meta: { ...ev },
    });
  } catch {
    // LogTail is observability only.
  }
};
