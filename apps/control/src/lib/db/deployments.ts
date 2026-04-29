import type { CodedError, Result } from '@raft/shared-types';
import { nowSeconds, wrap } from './internal.ts';
import type { Deployment, DeploymentRow, DeploymentStatus } from './types.ts';

const SELECT_COLS =
  'id, pr_env_id, head_sha, bundle_r2_key, status, error_message, duration_ms, started_at, finished_at';

const fromRow = (r: DeploymentRow): Deployment => ({
  id: r.id,
  prEnvId: r.pr_env_id,
  headSha: r.head_sha,
  bundleR2Key: r.bundle_r2_key,
  status: r.status,
  errorMessage: r.error_message,
  durationMs: r.duration_ms,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export interface CreateDeploymentInput {
  id: string;
  prEnvId: string;
  headSha: string;
  bundleR2Key: string;
  startedAt?: number;
}

export const createDeployment = (
  db: D1Database,
  input: CreateDeploymentInput,
): Promise<Result<Deployment, CodedError>> =>
  wrap('createDeployment', async () => {
    const startedAt = input.startedAt ?? nowSeconds();
    await db
      .prepare(
        `INSERT INTO deployments (id, pr_env_id, head_sha, bundle_r2_key, status, started_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`,
      )
      .bind(input.id, input.prEnvId, input.headSha, input.bundleR2Key, startedAt)
      .run();
    const row = await db
      .prepare(`SELECT ${SELECT_COLS} FROM deployments WHERE id = ?`)
      .bind(input.id)
      .first<DeploymentRow>();
    if (!row) throw new Error('createDeployment: row missing after insert');
    return fromRow(row);
  });

export const updateDeploymentStatus = (
  db: D1Database,
  id: string,
  status: DeploymentStatus,
  details?: { errorMessage?: string; durationMs?: number },
): Promise<Result<void, CodedError>> =>
  wrap('updateDeploymentStatus', async () => {
    const finishedAt = status === 'succeeded' || status === 'failed' ? nowSeconds() : null;
    await db
      .prepare(
        `UPDATE deployments SET status = ?, error_message = ?, duration_ms = ?, finished_at = ? WHERE id = ?`,
      )
      .bind(status, details?.errorMessage ?? null, details?.durationMs ?? null, finishedAt, id)
      .run();
  });

export const getDeployment = (
  db: D1Database,
  id: string,
): Promise<Result<Deployment | null, CodedError>> =>
  wrap('getDeployment', async () => {
    const row = await db
      .prepare(`SELECT ${SELECT_COLS} FROM deployments WHERE id = ?`)
      .bind(id)
      .first<DeploymentRow>();
    return row ? fromRow(row) : null;
  });

export const listDeploymentsForPrEnv = (
  db: D1Database,
  prEnvId: string,
  limit = 50,
): Promise<Result<Deployment[], CodedError>> =>
  wrap('listDeploymentsForPrEnv', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM deployments WHERE pr_env_id = ? ORDER BY started_at DESC LIMIT ?`,
      )
      .bind(prEnvId, limit)
      .all<DeploymentRow>();
    return res.results.map(fromRow);
  });
