import { z } from 'zod';
import type { CodedError, Result } from '@raft/shared-types';
import { type CFClient } from './client.ts';
import { queueSchema, type QueueShape } from './schemas.ts';

export const createQueue = (
  client: CFClient,
  queueName: string,
): Promise<Result<QueueShape, CodedError>> =>
  client.req({ method: 'POST', path: '/queues', body: { queue_name: queueName } }, queueSchema);

export const deleteQueue = (
  client: CFClient,
  queueId: string,
): Promise<Result<{ deleted: true }, CodedError>> =>
  client.req(
    { method: 'DELETE', path: `/queues/${queueId}` },
    z.unknown().transform(() => ({ deleted: true as const })),
  );
