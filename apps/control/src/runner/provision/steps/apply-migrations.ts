/**
 * Step 5 — apply-migrations: run the PR's pending `migrations/*.sql` against
 * the forked per-PR D1. This is the half of "database branching" that
 * Workers Builds previews cannot do — their preview runs the PR's code
 * against production bindings, so a migration in a PR either never runs or
 * runs against prod.
 *
 * Failure policy: SQL errors never throw. The Worker preview still goes
 * live; the result carries `status: 'failed'` with the exact SQLite error
 * so the PR comment and dashboard show it. Only a transport failure before
 * any write throws (retryable).
 */
import { CodedError } from '@raft/shared-types';
import { getInstallationToken } from '../../../lib/github/app.ts';
import { base64ToBytes, getRepoBlob } from '../../../lib/github/contents.ts';
import { appendAudit } from '../../../lib/db/auditLog.ts';
import { ulid } from '../../../lib/ids.ts';
import { applyPending, readAppliedMigrations } from '../../../lib/d1-migrations/apply.ts';
import { computePending } from '../../../lib/d1-migrations/plan.ts';
import type { MigrationFile } from '../../../lib/d1-migrations/types.ts';
import { cfClientFromCtx, requirePrior, type StepContext } from './context.ts';
import type { ApplyMigrationsResult, DbConfigSummary, ForkBaseDbResult } from './types.ts';

const skipped = (reason: string, t0: number): ApplyMigrationsResult => ({
  status: 'skipped',
  reason,
  alreadyApplied: [],
  applied: [],
  outcomes: [],
  warnings: [],
  notes: [],
  durationMs: Date.now() - t0,
});

const audit = (ctx: StepContext, action: string, metadata: Record<string, unknown>) =>
  appendAudit(ctx.env.DB, {
    id: ulid(),
    installationId: ctx.params.installationId,
    actor: 'provision-runner',
    action,
    targetType: 'pr_environment',
    targetId: ctx.prEnvId,
    metadata,
  });

const runPending = async (
  ctx: StepContext,
  db: DbConfigSummary,
  forkId: string,
  token: string,
  t0: number,
): Promise<ApplyMigrationsResult> => {
  const client = cfClientFromCtx(ctx);
  const already = await readAppliedMigrations(client, forkId);
  // Transport failure before any write: let the runner retry with backoff.
  if (!already.ok) {
    throw new CodedError('E_CF_API', `read d1_migrations failed: ${already.error.message}`);
  }
  const pending = computePending(db.migrationFiles, already.value);
  const fetchSql = async (f: MigrationFile): Promise<string> => {
    const blob = await getRepoBlob(token, ctx.params.repoFullName, f.sha);
    return new TextDecoder().decode(base64ToBytes(blob.content));
  };
  const run = await applyPending(client, forkId, pending, fetchSql);
  const applied = run.outcomes.filter((o) => o.status === 'applied').map((o) => o.name);
  const failed = run.outcomes.some((o) => o.status === 'failed');
  return {
    status: failed ? 'failed' : applied.length > 0 ? 'applied' : 'noop',
    baseDatabaseId: db.baseDatabaseId ?? '',
    forkDatabaseId: forkId,
    migrationsDir: db.migrationsDir,
    alreadyApplied: already.value,
    applied,
    outcomes: run.outcomes,
    warnings: run.warnings,
    notes: run.notes,
    durationMs: Date.now() - t0,
  };
};

export const applyMigrations = async (ctx: StepContext): Promise<ApplyMigrationsResult> => {
  const t0 = Date.now();
  const { config, provisioned } = requirePrior(ctx);
  const fork = ctx.prior['fork-base-db'] as ForkBaseDbResult | undefined;
  if (!config.db?.baseDatabaseId) return skipped('no-wrangler-d1', t0);
  if (config.db.migrationFiles.length === 0) return skipped('no-migrations', t0);

  let token: string;
  try {
    token = await getInstallationToken(
      ctx.env.CACHE,
      { appId: ctx.env.GITHUB_APP_ID, privateKeyPem: ctx.env.GITHUB_APP_PRIVATE_KEY },
      ctx.params.installationId,
    );
  } catch (e) {
    ctx.log.warn('apply_migrations_no_token', { error: String(e) });
    return skipped('no-github-token', t0);
  }

  const result = await runPending(ctx, config.db, provisioned.d1.database_id, token, t0);
  if (fork?.source !== 'forked') {
    result.notes.unshift('base DB was not forked — migrations ran on an empty DB');
  }
  const failedOne = result.outcomes.find((o) => o.status === 'failed');
  ctx.log.info('apply_migrations_done', {
    status: result.status,
    applied: result.applied,
    failed: failedOne?.name,
  });
  await audit(ctx, failedOne ? 'migration.failed' : 'migration.applied', {
    applied: result.applied,
    failed: failedOne?.name,
    error: failedOne?.error,
    warnings: result.warnings.length,
  });
  return result;
};
