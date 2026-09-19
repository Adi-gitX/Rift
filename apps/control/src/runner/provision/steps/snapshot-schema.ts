/**
 * Step 6 — snapshot-schema: read schema + row counts from the fork (and the
 * base, when we forked from one) and compute the diff the PR introduces.
 * Never throws on SQL/transport errors — the preview must not depend on it.
 */
import { snapshotSchema } from '../../../lib/d1-migrations/snapshot.ts';
import { diffSchemas } from '../../../lib/d1-migrations/diff.ts';
import { cfClientFromCtx, requirePrior, type StepContext } from './context.ts';
import type { ForkBaseDbResult, SnapshotSchemaResult } from './types.ts';

export const snapshotSchemaStep = async (ctx: StepContext): Promise<SnapshotSchemaResult> => {
  const { config, provisioned } = requirePrior(ctx);
  const fork = ctx.prior['fork-base-db'] as ForkBaseDbResult | undefined;
  if (!config.db?.baseDatabaseId && fork?.source !== 'forked') {
    return { status: 'skipped', reason: 'no-base-d1' };
  }
  const client = cfClientFromCtx(ctx);
  const forkSnap = await snapshotSchema(client, provisioned.d1.database_id);
  if (!forkSnap.ok) {
    ctx.log.warn('snapshot_schema_fork_failed', { error: forkSnap.error.message });
    return { status: 'partial', error: `fork snapshot failed: ${forkSnap.error.message}` };
  }
  const baseId = fork?.source === 'forked' ? fork.baseDatabaseId : undefined;
  if (!baseId) {
    return { status: 'fork-only', reason: fork?.reason ?? 'not-forked', fork: forkSnap.value };
  }
  const baseSnap = await snapshotSchema(client, baseId);
  if (!baseSnap.ok) {
    ctx.log.warn('snapshot_schema_base_failed', { error: baseSnap.error.message });
    return {
      status: 'partial',
      fork: forkSnap.value,
      error: `base snapshot failed: ${baseSnap.error.message}`,
    };
  }
  const diff = diffSchemas(baseSnap.value, forkSnap.value);
  ctx.log.info('snapshot_schema_ok', {
    tables_added: diff.tablesAdded.length,
    columns_added: diff.columnsAdded.length,
    row_deltas: diff.rowDeltas.length,
  });
  return { status: 'diffed', fork: forkSnap.value, base: baseSnap.value, diff };
};
