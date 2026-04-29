import { z } from 'zod';
import type { CodedError, Result } from '@raft/shared-types';
import { type CFClient } from './client.ts';
import { kvNamespaceSchema, type KvNamespaceShape } from './schemas.ts';

export const createNamespace = (
  client: CFClient,
  title: string,
): Promise<Result<KvNamespaceShape, CodedError>> =>
  client.req(
    { method: 'POST', path: '/storage/kv/namespaces', body: { title } },
    kvNamespaceSchema,
  );

export const deleteNamespace = (
  client: CFClient,
  id: string,
): Promise<Result<{ deleted: true }, CodedError>> =>
  client.req(
    { method: 'DELETE', path: `/storage/kv/namespaces/${id}` },
    z.unknown().transform(() => ({ deleted: true as const })),
  );
