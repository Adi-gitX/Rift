/**
 * Step 4 — fork-base-db: seed the per-PR D1 with the base DB's schema + data
 * via the D1 export → import REST flow (PRD §9.3, amendment A3).
 *
 * Source preference:
 *   1. wrangler `d1_databases[0].database_id` at headSha (load-config)
 *   2. repo.baseD1Id (persisted from an earlier detection)
 *   3. RAFT_DEMO_BASE_D1_ID (demo-mode default)
 * Skipped if none, or if the source equals the target (self-fork guard).
 *
 * One-shot per PR env: the runner keeps this step's cache across
 * synchronize/redeploy, because re-importing on top of a seeded DB would
 * duplicate rows and conflict with migrations already applied.
 */
import * as cfD1 from '../../../lib/cloudflare/d1.ts';
import { getRepo, repoIdOf } from '../../../lib/db/repos.ts';
import { cfClientFromCtx, requirePrior, sha256Hex, type StepContext } from './context.ts';
import type { ForkBaseDbResult } from './types.ts';

const resolveBase = async (ctx: StepContext): Promise<{ id: string | null; name?: string }> => {
  const { config } = requirePrior(ctx);
  if (config.db?.baseDatabaseId) {
    const out: { id: string; name?: string } = { id: config.db.baseDatabaseId };
    if (config.db.baseDatabaseName) out.name = config.db.baseDatabaseName;
    return out;
  }
  const repoRow = await getRepo(
    ctx.env.DB,
    repoIdOf(ctx.params.installationId, ctx.params.repoFullName),
  );
  const fromRepo = repoRow.ok && repoRow.value?.baseD1Id ? repoRow.value.baseD1Id : null;
  return { id: fromRepo ?? ctx.env.RAFT_DEMO_BASE_D1_ID ?? null };
};

export const forkBaseDb = async (ctx: StepContext): Promise<ForkBaseDbResult> => {
  const { provisioned } = requirePrior(ctx);
  const base = await resolveBase(ctx);
  if (!base.id) {
    ctx.log.info('fork_base_db_skipped', { reason: 'no-base-d1' });
    return { source: 'skipped', reason: 'no-base-d1' };
  }
  if (base.id === provisioned.d1.database_id) {
    ctx.log.warn('fork_base_db_skipped', { reason: 'self-fork-blocked' });
    return { source: 'skipped', reason: 'self-fork-blocked' };
  }
  // Failures (source missing, export timeout, rate limit) are non-fatal —
  // degrade to "empty per-PR DB" rather than failing the whole provision.
  const copied = await copyDatabase(ctx, base.id, provisioned.d1.database_id);
  if (!copied.ok) {
    ctx.log.warn('fork_base_db_degrading', { base: base.id, reason: copied.reason });
    return { source: 'skipped', baseDatabaseId: base.id, reason: copied.reason };
  }
  ctx.log.info('fork_base_db_ok', {
    base: base.id,
    target: provisioned.d1.database_id,
    sql_bytes: copied.sqlBytes,
  });
  const result: ForkBaseDbResult = {
    source: 'forked',
    baseDatabaseId: base.id,
    sqlBytes: copied.sqlBytes,
  };
  if (base.name) result.baseDatabaseName = base.name;
  return result;
};

/** Export `from` to SQL, import into `to`. Returns a reason string on either failure. */
const copyDatabase = async (
  ctx: StepContext,
  from: string,
  to: string,
): Promise<{ ok: true; sqlBytes: number } | { ok: false; reason: string }> => {
  const client = cfClientFromCtx(ctx);
  const sql = await cfD1.exportSqlAndWait(client, from);
  if (!sql.ok) return { ok: false, reason: `export_failed: ${sql.error.message}` };
  const etag = await sha256Hex(sql.value);
  const importR = await cfD1.importSqlAndWait(client, to, sql.value, etag);
  if (!importR.ok) return { ok: false, reason: `import_failed: ${importR.error.message}` };
  return { ok: true, sqlBytes: sql.value.length };
};
