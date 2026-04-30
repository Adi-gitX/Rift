import { z } from 'zod';
import type { CodedError, Result } from '@raft/shared-types';
import { ok } from '@raft/shared-types';
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

/**
 * Idempotent: try create, fall back to list-and-find on any create failure.
 */
export const findOrCreateNamespace = async (
  client: CFClient,
  title: string,
): Promise<Result<KvNamespaceShape, CodedError>> => {
  const create = await createNamespace(client, title);
  if (create.ok) return create;
  const list = await client.req(
    { method: 'GET', path: '/storage/kv/namespaces?per_page=100' },
    z.array(kvNamespaceSchema.passthrough()),
  );
  if (list.ok) {
    const existing = list.value.find((n) => n.title === title);
    if (existing) return ok(existing);
  }
  return create;
};

export const deleteNamespace = (
  client: CFClient,
  id: string,
): Promise<Result<{ deleted: true }, CodedError>> =>
  client.req(
    { method: 'DELETE', path: `/storage/kv/namespaces/${id}` },
    z.unknown().transform(() => ({ deleted: true as const })),
  );
