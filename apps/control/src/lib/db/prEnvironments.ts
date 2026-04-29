import type { CodedError, Result } from '@raft/shared-types';
import { nowSeconds, wrap } from './internal.ts';
import type { PrEnvState, PrEnvironment, PrEnvironmentRow } from './types.ts';

const SELECT_COLS =
  'id, repo_id, pr_number, state, state_reason, head_sha, preview_hostname, runner_do_id, d1_database_id, kv_namespace_id, queue_id, worker_script_name, r2_prefix, do_namespace_seed, pr_comment_id, created_at, ready_at, last_activity_at, torn_down_at';

export const prEnvIdOf = (repoId: string, prNumber: number): string => `${repoId}:${prNumber}`;

const fromRow = (r: PrEnvironmentRow): PrEnvironment => ({
  id: r.id,
  repoId: r.repo_id,
  prNumber: r.pr_number,
  state: r.state,
  stateReason: r.state_reason,
  headSha: r.head_sha,
  previewHostname: r.preview_hostname,
  runnerDoId: r.runner_do_id,
  resources: {
    d1DatabaseId: r.d1_database_id,
    kvNamespaceId: r.kv_namespace_id,
    queueId: r.queue_id,
    workerScriptName: r.worker_script_name,
    r2Prefix: r.r2_prefix,
    doNamespaceSeed: r.do_namespace_seed,
  },
  prCommentId: r.pr_comment_id,
  createdAt: r.created_at,
  readyAt: r.ready_at,
  lastActivityAt: r.last_activity_at,
  tornDownAt: r.torn_down_at,
});

export interface CreatePrEnvInput {
  repoId: string;
  prNumber: number;
  headSha: string;
}

export const createPrEnvironment = (
  db: D1Database,
  input: CreatePrEnvInput,
): Promise<Result<PrEnvironment, CodedError>> =>
  wrap('createPrEnvironment', async () => {
    const id = prEnvIdOf(input.repoId, input.prNumber);
    const now = nowSeconds();
    await db
      .prepare(
        `INSERT INTO pr_environments (id, repo_id, pr_number, state, head_sha, created_at, last_activity_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)
         ON CONFLICT(repo_id, pr_number) DO UPDATE SET
           head_sha = excluded.head_sha,
           last_activity_at = excluded.last_activity_at`,
      )
      .bind(id, input.repoId, input.prNumber, input.headSha, now, now)
      .run();
    return await getRequired(db, id);
  });

export const getPrEnvironment = (
  db: D1Database,
  id: string,
): Promise<Result<PrEnvironment | null, CodedError>> =>
  wrap('getPrEnvironment', async () => {
    const row = await db
      .prepare(`SELECT ${SELECT_COLS} FROM pr_environments WHERE id = ?`)
      .bind(id)
      .first<PrEnvironmentRow>();
    return row ? fromRow(row) : null;
  });

export const listPrEnvironmentsForRepo = (
  db: D1Database,
  repoId: string,
): Promise<Result<PrEnvironment[], CodedError>> =>
  wrap('listPrEnvironmentsForRepo', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM pr_environments WHERE repo_id = ? ORDER BY pr_number DESC`,
      )
      .bind(repoId)
      .all<PrEnvironmentRow>();
    return res.results.map(fromRow);
  });

export const transitionState = (
  db: D1Database,
  id: string,
  state: PrEnvState,
  reason?: string,
): Promise<Result<void, CodedError>> =>
  wrap('transitionState', async () => {
    const now = nowSeconds();
    const readyClause = state === 'ready' ? ', ready_at = ?' : '';
    const tornDownClause = state === 'torn_down' ? ', torn_down_at = ?' : '';
    const stmt = `UPDATE pr_environments SET state = ?, state_reason = ?, last_activity_at = ?${readyClause}${tornDownClause} WHERE id = ?`;
    const bindings: (string | number | null)[] = [state, reason ?? null, now];
    if (state === 'ready') bindings.push(now);
    if (state === 'torn_down') bindings.push(now);
    bindings.push(id);
    await db.prepare(stmt).bind(...bindings).run();
  });

export interface ResourceHandles {
  runnerDoId?: string;
  d1DatabaseId?: string;
  kvNamespaceId?: string;
  queueId?: string;
  workerScriptName?: string;
  r2Prefix?: string;
  doNamespaceSeed?: string;
  previewHostname?: string;
  prCommentId?: number;
}

export const setResourceHandles = (
  db: D1Database,
  id: string,
  h: ResourceHandles,
): Promise<Result<void, CodedError>> =>
  wrap('setResourceHandles', async () => {
    await db
      .prepare(
        `UPDATE pr_environments SET
          runner_do_id        = COALESCE(?, runner_do_id),
          d1_database_id      = COALESCE(?, d1_database_id),
          kv_namespace_id     = COALESCE(?, kv_namespace_id),
          queue_id            = COALESCE(?, queue_id),
          worker_script_name  = COALESCE(?, worker_script_name),
          r2_prefix           = COALESCE(?, r2_prefix),
          do_namespace_seed   = COALESCE(?, do_namespace_seed),
          preview_hostname    = COALESCE(?, preview_hostname),
          pr_comment_id       = COALESCE(?, pr_comment_id),
          last_activity_at    = ?
         WHERE id = ?`,
      )
      .bind(
        h.runnerDoId ?? null,
        h.d1DatabaseId ?? null,
        h.kvNamespaceId ?? null,
        h.queueId ?? null,
        h.workerScriptName ?? null,
        h.r2Prefix ?? null,
        h.doNamespaceSeed ?? null,
        h.previewHostname ?? null,
        h.prCommentId ?? null,
        nowSeconds(),
        id,
      )
      .run();
  });

export const listStalePrEnvironments = (
  db: D1Database,
  staleBefore: number,
  limit = 100,
): Promise<Result<PrEnvironment[], CodedError>> =>
  wrap('listStalePrEnvironments', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM pr_environments
         WHERE state = 'ready' AND last_activity_at < ?
         ORDER BY last_activity_at ASC
         LIMIT ?`,
      )
      .bind(staleBefore, limit)
      .all<PrEnvironmentRow>();
    return res.results.map(fromRow);
  });

const getRequired = async (db: D1Database, id: string): Promise<PrEnvironment> => {
  const row = await db
    .prepare(`SELECT ${SELECT_COLS} FROM pr_environments WHERE id = ?`)
    .bind(id)
    .first<PrEnvironmentRow>();
  if (!row) throw new Error(`pr_environment ${id} not found after upsert`);
  return fromRow(row);
};
