import { z } from 'zod';
import type { CodedError, Result } from '@raft/shared-types';
import { ok } from '@raft/shared-types';
import { type CFClient } from './client.ts';
import { queueSchema, type QueueShape } from './schemas.ts';

export const createQueue = (
  client: CFClient,
  queueName: string,
): Promise<Result<QueueShape, CodedError>> =>
  client.req({ method: 'POST', path: '/queues', body: { queue_name: queueName } }, queueSchema);

/**
 * Idempotent: try create, fall back to list-and-find on any create failure.
 */
export const findOrCreateQueue = async (
  client: CFClient,
  queueName: string,
): Promise<Result<QueueShape, CodedError>> => {
  const create = await createQueue(client, queueName);
  if (create.ok) return create;
  const list = await client.req(
    { method: 'GET', path: '/queues?per_page=100' },
    z.array(queueSchema.passthrough()),
  );
  if (list.ok) {
    const existing = list.value.find((q) => q.queue_name === queueName);
    if (existing) return ok(existing);
  }
  return create;
};

export const deleteQueue = (
  client: CFClient,
  queueId: string,
): Promise<Result<{ deleted: true }, CodedError>> =>
  client.req(
    { method: 'DELETE', path: `/queues/${queueId}` },
    z.unknown().transform(() => ({ deleted: true as const })),
  );
