/**
 * Slice F integration test: tail-events queue → LogTail DO ring buffer.
 *
 * Simulates a Tail Worker batch landing in raft-tail-events and verifies the
 * per-PR LogTail DO appends each trace into its ring buffer. The hibernatable
 * WebSocket fan-out is exercised at runtime via `/ws`; here we read the buffer
 * directly through the DO's `/tail` debug endpoint to confirm append worked.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { handleTailQueueBatch } from '../../src/queue/tail-consumer.ts';
import type { TailEvent } from '../../src/env.ts';
import type { LogTail, LogEvent } from '../../src/do/log-tail.ts';

const fakeBatch = (msg: TailEvent): MessageBatch<TailEvent> => {
  const noop = (): void => undefined;
  return {
    queue: 'raft-tail-events',
    messages: [
      {
        id: 'm1',
        timestamp: new Date(),
        body: msg,
        attempts: 1,
        ack: noop,
        retry: noop,
      } as Message<TailEvent>,
    ],
    ackAll: noop,
    retryAll: noop,
  } as MessageBatch<TailEvent>;
};

describe('Slice F LogTail DO + tail-events queue', () => {
  it('appends trace events to the LogTail DO ring buffer for the right PR env', async () => {
    const prEnvId = 'pr-env-tail-1';
    const scriptName = 'raft-test-tail-pr-1';
    // Reverse index: scriptName → prEnvId
    await env.ROUTES.put(`script:${scriptName}:pr`, prEnvId);

    const traceItem = {
      eventTimestamp: 1700000000000,
      logs: [{ level: 'info', message: ['hello from worker'] }],
    };
    await handleTailQueueBatch(
      fakeBatch({ scriptName, events: [traceItem] }),
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExecutionContext stub for test
      {} as any,
    );

    const stub = env.LOGTAIL.get(env.LOGTAIL.idFromName(prEnvId)) as DurableObjectStub<LogTail>;
    const res = await stub.fetch('https://internal/tail');
    const buf = (await res.json()) as LogEvent[];
    expect(buf).toHaveLength(1);
    expect(buf[0]?.scriptName).toBe(scriptName);
    expect(buf[0]?.msg).toBe('hello from worker');
  });

  it('drops events when the script has no PR-env mapping (no error)', async () => {
    await handleTailQueueBatch(
      fakeBatch({ scriptName: 'unknown-script', events: [{ eventTimestamp: 1, logs: [] }] }),
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExecutionContext stub for test
      {} as any,
    );
    // Simply not throwing is the assertion.
    expect(true).toBe(true);
  });
});
