import type { CodedError, Result } from '@raft/shared-types';
import { wrap } from './internal.ts';
import type { UsageRecord, UsageRecordRow } from './types.ts';

const SELECT_COLS =
  'id, installation_id, period_start, period_end, pr_envs_active, pr_envs_created, d1_size_bytes, r2_size_bytes';

const fromRow = (r: UsageRecordRow): UsageRecord => ({
  id: r.id,
  installationId: r.installation_id,
  periodStart: r.period_start,
  periodEnd: r.period_end,
  prEnvsActive: r.pr_envs_active,
  prEnvsCreated: r.pr_envs_created,
  d1SizeBytes: r.d1_size_bytes,
  r2SizeBytes: r.r2_size_bytes,
});

export interface UpsertUsageInput {
  id: string;
  installationId: string;
  periodStart: number;
  periodEnd: number;
  prEnvsActive: number;
  prEnvsCreated: number;
  d1SizeBytes: number;
  r2SizeBytes: number;
}

export const upsertUsageRecord = (
  db: D1Database,
  input: UpsertUsageInput,
): Promise<Result<void, CodedError>> =>
  wrap('upsertUsageRecord', async () => {
    await db
      .prepare(
        `INSERT INTO usage_records (id, installation_id, period_start, period_end, pr_envs_active, pr_envs_created, d1_size_bytes, r2_size_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(installation_id, period_start) DO UPDATE SET
           period_end       = excluded.period_end,
           pr_envs_active   = excluded.pr_envs_active,
           pr_envs_created  = excluded.pr_envs_created,
           d1_size_bytes    = excluded.d1_size_bytes,
           r2_size_bytes    = excluded.r2_size_bytes`,
      )
      .bind(
        input.id,
        input.installationId,
        input.periodStart,
        input.periodEnd,
        input.prEnvsActive,
        input.prEnvsCreated,
        input.d1SizeBytes,
        input.r2SizeBytes,
      )
      .run();
  });

export const getUsageForPeriod = (
  db: D1Database,
  installationId: string,
  periodStart: number,
): Promise<Result<UsageRecord | null, CodedError>> =>
  wrap('getUsageForPeriod', async () => {
    const row = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM usage_records WHERE installation_id = ? AND period_start = ?`,
      )
      .bind(installationId, periodStart)
      .first<UsageRecordRow>();
    return row ? fromRow(row) : null;
  });

export const listUsageForInstallation = (
  db: D1Database,
  installationId: string,
  limit = 90,
): Promise<Result<UsageRecord[], CodedError>> =>
  wrap('listUsageForInstallation', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM usage_records
         WHERE installation_id = ?
         ORDER BY period_start DESC
         LIMIT ?`,
      )
      .bind(installationId, limit)
      .all<UsageRecordRow>();
    return res.results.map(fromRow);
  });
