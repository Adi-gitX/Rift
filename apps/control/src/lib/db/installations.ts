import type { CodedError, Result } from '@raft/shared-types';
import { nowSeconds, safeJson, wrap } from './internal.ts';
import type { AccountType, Installation, InstallationRow, Plan } from './types.ts';

const SELECT_COLS =
  'id, github_account, github_account_id, account_type, cloudflare_account_id, cloudflare_token_secret_id, plan, active, installed_at, uninstalled_at, config_json';

const fromRow = (r: InstallationRow): Installation => ({
  id: r.id,
  githubAccount: r.github_account,
  githubAccountId: r.github_account_id,
  accountType: r.account_type,
  cloudflareAccountId: r.cloudflare_account_id,
  cloudflareTokenSecretId: r.cloudflare_token_secret_id,
  plan: r.plan,
  active: r.active === 1,
  installedAt: r.installed_at,
  uninstalledAt: r.uninstalled_at,
  config: safeJson(r.config_json),
});

export interface UpsertInstallationInput {
  id: string;
  githubAccount: string;
  githubAccountId: number;
  accountType: AccountType;
  plan?: Plan;
  installedAt?: number;
}

export const upsertInstallation = (
  db: D1Database,
  input: UpsertInstallationInput,
): Promise<Result<void, CodedError>> =>
  wrap('upsertInstallation', async () => {
    const installedAt = input.installedAt ?? nowSeconds();
    await db
      .prepare(
        `INSERT INTO installations (id, github_account, github_account_id, account_type, plan, active, installed_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           github_account = excluded.github_account,
           github_account_id = excluded.github_account_id,
           account_type = excluded.account_type,
           active = 1,
           uninstalled_at = NULL`,
      )
      .bind(
        input.id,
        input.githubAccount,
        input.githubAccountId,
        input.accountType,
        input.plan ?? 'free',
        installedAt,
      )
      .run();
  });

export const getInstallation = (
  db: D1Database,
  id: string,
): Promise<Result<Installation | null, CodedError>> =>
  wrap('getInstallation', async () => {
    const row = await db
      .prepare(`SELECT ${SELECT_COLS} FROM installations WHERE id = ?`)
      .bind(id)
      .first<InstallationRow>();
    return row ? fromRow(row) : null;
  });

export const listActiveInstallations = (
  db: D1Database,
): Promise<Result<Installation[], CodedError>> =>
  wrap('listActiveInstallations', async () => {
    const res = await db
      .prepare(`SELECT ${SELECT_COLS} FROM installations WHERE active = 1 ORDER BY installed_at DESC`)
      .all<InstallationRow>();
    return res.results.map(fromRow);
  });

export const softDeleteInstallation = (
  db: D1Database,
  id: string,
  uninstalledAt: number = nowSeconds(),
): Promise<Result<void, CodedError>> =>
  wrap('softDeleteInstallation', async () => {
    await db
      .prepare(`UPDATE installations SET active = 0, uninstalled_at = ? WHERE id = ?`)
      .bind(uninstalledAt, id)
      .run();
  });

export const setCloudflareConnection = (
  db: D1Database,
  id: string,
  accountId: string,
  tokenSecretId: string,
): Promise<Result<void, CodedError>> =>
  wrap('setCloudflareConnection', async () => {
    await db
      .prepare(
        `UPDATE installations SET cloudflare_account_id = ?, cloudflare_token_secret_id = ? WHERE id = ?`,
      )
      .bind(accountId, tokenSecretId, id)
      .run();
  });
