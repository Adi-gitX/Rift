import type { CodedError, Result } from '@raft/shared-types';
import { nowSeconds, safeJson, safeJsonArray, wrap } from './internal.ts';
import type { Repo, RepoRow } from './types.ts';

const SELECT_COLS =
  'id, installation_id, github_repo_id, full_name, default_branch, base_d1_id, base_kv_id, base_r2_bucket, base_queue_name, do_class_names, raft_config_json, upload_token_hash, created_at';

export const repoIdOf = (installationId: string, fullName: string): string =>
  `${installationId}:${fullName}`;

const fromRow = (r: RepoRow): Repo => ({
  id: r.id,
  installationId: r.installation_id,
  githubRepoId: r.github_repo_id,
  fullName: r.full_name,
  defaultBranch: r.default_branch,
  baseD1Id: r.base_d1_id,
  baseKvId: r.base_kv_id,
  baseR2Bucket: r.base_r2_bucket,
  baseQueueName: r.base_queue_name,
  doClassNames: safeJsonArray<string>(r.do_class_names),
  raftConfig: safeJson(r.raft_config_json),
  uploadTokenHash: r.upload_token_hash,
  createdAt: r.created_at,
});

export interface UpsertRepoInput {
  installationId: string;
  githubRepoId: number;
  fullName: string;
  defaultBranch?: string;
  uploadTokenHash: string;
}

/**
 * Upserts a repo row. Generates a deterministic id of the form
 * `{installation_id}:{full_name}`. Creates the row on first sight; preserves
 * upload_token_hash on subsequent installs (rotation goes through
 * `rotateUploadTokenHash`).
 */
export const upsertRepo = (
  db: D1Database,
  input: UpsertRepoInput,
): Promise<Result<Repo, CodedError>> =>
  wrap('upsertRepo', async () => {
    const id = repoIdOf(input.installationId, input.fullName);
    const createdAt = nowSeconds();
    await db
      .prepare(
        `INSERT INTO repos (id, installation_id, github_repo_id, full_name, default_branch, upload_token_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           github_repo_id = excluded.github_repo_id,
           default_branch = excluded.default_branch`,
      )
      .bind(
        id,
        input.installationId,
        input.githubRepoId,
        input.fullName,
        input.defaultBranch ?? 'main',
        input.uploadTokenHash,
        createdAt,
      )
      .run();
    const row = await db
      .prepare(`SELECT ${SELECT_COLS} FROM repos WHERE id = ?`)
      .bind(id)
      .first<RepoRow>();
    if (!row) throw new Error('upsertRepo: row missing after insert');
    return fromRow(row);
  });

export const getRepo = (db: D1Database, id: string): Promise<Result<Repo | null, CodedError>> =>
  wrap('getRepo', async () => {
    const row = await db
      .prepare(`SELECT ${SELECT_COLS} FROM repos WHERE id = ?`)
      .bind(id)
      .first<RepoRow>();
    return row ? fromRow(row) : null;
  });

export const listReposForInstallation = (
  db: D1Database,
  installationId: string,
): Promise<Result<Repo[], CodedError>> =>
  wrap('listReposForInstallation', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM repos WHERE installation_id = ? ORDER BY full_name ASC`,
      )
      .bind(installationId)
      .all<RepoRow>();
    return res.results.map(fromRow);
  });

export const rotateUploadTokenHash = (
  db: D1Database,
  id: string,
  newHash: string,
): Promise<Result<void, CodedError>> =>
  wrap('rotateUploadTokenHash', async () => {
    await db
      .prepare(`UPDATE repos SET upload_token_hash = ? WHERE id = ?`)
      .bind(newHash, id)
      .run();
  });

export const setBaseResources = (
  db: D1Database,
  id: string,
  bases: {
    baseD1Id?: string;
    baseKvId?: string;
    baseR2Bucket?: string;
    baseQueueName?: string;
    doClassNames?: string[];
    raftConfig?: Record<string, unknown>;
  },
): Promise<Result<void, CodedError>> =>
  wrap('setBaseResources', async () => {
    await db
      .prepare(
        `UPDATE repos SET
          base_d1_id = COALESCE(?, base_d1_id),
          base_kv_id = COALESCE(?, base_kv_id),
          base_r2_bucket = COALESCE(?, base_r2_bucket),
          base_queue_name = COALESCE(?, base_queue_name),
          do_class_names = COALESCE(?, do_class_names),
          raft_config_json = COALESCE(?, raft_config_json)
         WHERE id = ?`,
      )
      .bind(
        bases.baseD1Id ?? null,
        bases.baseKvId ?? null,
        bases.baseR2Bucket ?? null,
        bases.baseQueueName ?? null,
        bases.doClassNames ? JSON.stringify(bases.doClassNames) : null,
        bases.raftConfig ? JSON.stringify(bases.raftConfig) : null,
        id,
      )
      .run();
  });
