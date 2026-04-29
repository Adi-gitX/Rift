/**
 * R2 helpers — bucket lifecycle rules + listing/deleting objects within a
 * Raft-shared prefix. (Buckets themselves are managed by the bootstrap
 * script; this module deals only with per-PR prefix lifecycle + cleanup.)
 */
import { z } from 'zod';
import type { CodedError, Result } from '@raft/shared-types';
import { type CFClient } from './client.ts';

export interface LifecycleRule {
  id: string;
  prefix: string;
  enabled: boolean;
  conditions: { age_seconds: number };
}

export const setLifecycleRule = (
  client: CFClient,
  bucketName: string,
  rule: LifecycleRule,
): Promise<Result<{ updated: true }, CodedError>> =>
  client.req(
    {
      method: 'PUT',
      path: `/r2/buckets/${bucketName}/lifecycle`,
      body: {
        rules: [
          {
            id: rule.id,
            enabled: rule.enabled,
            conditions: { prefix: rule.prefix },
            deleteObjectsTransition: { condition: { type: 'Age', maxAge: rule.conditions.age_seconds } },
          },
        ],
      },
    },
    z.unknown().transform(() => ({ updated: true as const })),
  );

/** Bulk-delete every key under a prefix using the per-bucket R2 binding (not the REST API). */
export const purgePrefix = async (
  bucket: R2Bucket,
  prefix: string,
): Promise<Result<{ deleted: number }, CodedError>> => {
  let deleted = 0;
  let cursor: string | undefined;
  for (;;) {
    const opts: R2ListOptions = cursor === undefined
      ? { prefix, limit: 1000 }
      : { prefix, limit: 1000, cursor };
    const list = await bucket.list(opts);
    if (list.objects.length === 0) break;
    await bucket.delete(list.objects.map((o) => o.key));
    deleted += list.objects.length;
    if (!list.truncated) break;
    cursor = list.cursor;
  }
  return { ok: true, value: { deleted } };
};
