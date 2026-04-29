import type { CodedError, Result } from '@raft/shared-types';
import { nowSeconds, safeJson, wrap } from './internal.ts';
import type { AuditEntry, AuditLogRow } from './types.ts';

const SELECT_COLS =
  'id, installation_id, actor, action, target_type, target_id, metadata_json, created_at';

const fromRow = (r: AuditLogRow): AuditEntry => ({
  id: r.id,
  installationId: r.installation_id,
  actor: r.actor,
  action: r.action,
  targetType: r.target_type,
  targetId: r.target_id,
  metadata: safeJson(r.metadata_json),
  createdAt: r.created_at,
});

export interface AppendAuditInput {
  id: string;
  installationId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
}

export const appendAudit = (
  db: D1Database,
  input: AppendAuditInput,
): Promise<Result<void, CodedError>> =>
  wrap('appendAudit', async () => {
    await db
      .prepare(
        `INSERT INTO audit_log (id, installation_id, actor, action, target_type, target_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.installationId,
        input.actor,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(input.metadata ?? {}),
        input.createdAt ?? nowSeconds(),
      )
      .run();
  });

export const listAuditForInstallation = (
  db: D1Database,
  installationId: string,
  limit = 100,
): Promise<Result<AuditEntry[], CodedError>> =>
  wrap('listAuditForInstallation', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM audit_log
         WHERE installation_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(installationId, limit)
      .all<AuditLogRow>();
    return res.results.map(fromRow);
  });

export const listAuditForTarget = (
  db: D1Database,
  targetType: string,
  targetId: string,
  limit = 100,
): Promise<Result<AuditEntry[], CodedError>> =>
  wrap('listAuditForTarget', async () => {
    const res = await db
      .prepare(
        `SELECT ${SELECT_COLS} FROM audit_log
         WHERE target_type = ? AND target_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(targetType, targetId, limit)
      .all<AuditLogRow>();
    return res.results.map(fromRow);
  });
