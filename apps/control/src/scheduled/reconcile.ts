/**
 * Orphan reconciler — the safety net under the teardown machine.
 *
 * Lists every Worker / D1 / KV / Queue on the account whose name matches the
 * per-PR pattern (`raft-<install>-<repo>-pr-<n>[-db|-kv|-q]`) and compares
 * against pr_environments. Anything whose PR env is `torn_down`/`failed`
 * (or, with `force`, has no row at all) is an orphan: a teardown that
 * reported success while a redeploy was re-creating resources, a crashed
 * runner, a manual `wrangler delete` of the meta row… Deletes are
 * idempotent (404 = already gone) and audited.
 *
 * Runs daily from `scheduled()` and on demand via POST /api/v1/admin/reconcile.
 */
import type { Env } from '../env.ts';
import { CFClient } from '../lib/cloudflare/client.ts';
import * as cfD1 from '../lib/cloudflare/d1.ts';
import * as cfKv from '../lib/cloudflare/kv.ts';
import * as cfQueues from '../lib/cloudflare/queues.ts';
import * as cfWorkers from '../lib/cloudflare/workers.ts';
import { readListBody } from '../lib/cloudflare/list.ts';
import { appendAudit } from '../lib/db/auditLog.ts';
import { ulid } from '../lib/ids.ts';
import { Logger } from '../lib/logger.ts';
import { listActiveInstallations } from '../lib/db/installations.ts';
import {
  resolveCloudflareCredentials,
  sharedCredentials,
  type CloudflareCredentials,
} from '../lib/tenant.ts';

export type OrphanKind = 'worker' | 'd1' | 'kv' | 'queue';

export interface Orphan {
  kind: OrphanKind;
  /** CF identifier the DELETE endpoint needs (script name, D1 uuid, KV id, queue uuid). */
  id: string;
  name: string;
  /** The per-PR Worker script name this resource belongs to. */
  scriptName: string;
  /** Matching pr_environments row, if any. */
  prEnvId?: string;
  prEnvState?: string;
  installationId?: string;
}

export interface AccountResources {
  scripts: { id: string }[];
  d1: { uuid: string; name: string }[];
  kv: { id: string; title: string }[];
  queues: { queue_id: string; queue_name: string }[];
}

const PR_RESOURCE_RE = /^(raft-[a-z0-9]+-[a-z0-9]+-pr-\d+)(-db|-kv|-q)?$/;

/** Script name a per-PR resource belongs to, or null for control-plane / foreign resources. */
export const derivePrScriptName = (name: string): string | null =>
  PR_RESOURCE_RE.exec(name)?.[1] ?? null;

export const listAccountResources = async (
  client: CFClient,
  log: Logger,
): Promise<AccountResources> => {
  const [scripts, d1, kv, queues] = await Promise.all([
    readListBody(client, log, '/workers/scripts', 'scripts'),
    readListBody(client, log, '/d1/database?per_page=1000', 'd1'),
    readListBody(client, log, '/storage/kv/namespaces?per_page=100', 'kv'),
    readListBody(client, log, '/queues?per_page=100', 'queues'),
  ]);
  return {
    scripts: (scripts ?? []) as AccountResources['scripts'],
    d1: (d1 ?? []) as AccountResources['d1'],
    kv: (kv ?? []) as AccountResources['kv'],
    queues: (queues ?? []) as AccountResources['queues'],
  };
};

interface EnvRow {
  id: string;
  state: string;
  worker_script_name: string;
  installation_id: string;
}

const readEnvRows = async (db: D1Database): Promise<Map<string, EnvRow>> => {
  const r = await db
    .prepare(
      `SELECT p.id, p.state, p.worker_script_name, r.installation_id
         FROM pr_environments p JOIN repos r ON r.id = p.repo_id
        WHERE p.worker_script_name IS NOT NULL`,
    )
    .all<EnvRow>();
  return new Map((r.results ?? []).map((row) => [row.worker_script_name, row]));
};

const candidates = (
  res: AccountResources,
): Omit<Orphan, 'prEnvId' | 'prEnvState' | 'installationId'>[] => {
  const out: Omit<Orphan, 'prEnvId' | 'prEnvState' | 'installationId'>[] = [];
  const push = (kind: OrphanKind, id: string, name: string): void => {
    const scriptName = derivePrScriptName(name);
    if (scriptName) out.push({ kind, id, name, scriptName });
  };
  for (const s of res.scripts) push('worker', s.id, s.id);
  for (const d of res.d1) push('d1', d.uuid, d.name);
  for (const k of res.kv) push('kv', k.id, k.title);
  for (const q of res.queues) push('queue', q.queue_id, q.queue_name);
  return out;
};

/**
 * Orphans = per-PR resources whose env row is terminal (`torn_down` / `failed`).
 * With `force`, resources with no row at all are included too — only reach
 * for that when you know nothing else on the account uses the raft-* prefix.
 */
export const findOrphans = (
  res: AccountResources,
  rows: Map<string, EnvRow>,
  opts: { force: boolean },
): Orphan[] => {
  const out: Orphan[] = [];
  for (const c of candidates(res)) {
    const row = rows.get(c.scriptName);
    if (row) {
      if (row.state === 'torn_down' || row.state === 'failed') {
        out.push({
          ...c,
          prEnvId: row.id,
          prEnvState: row.state,
          installationId: row.installation_id,
        });
      }
    } else if (opts.force) {
      out.push(c);
    }
  }
  return out;
};

const deleteOne = async (client: CFClient, o: Orphan): Promise<{ ok: boolean; error?: string }> => {
  const r =
    o.kind === 'worker'
      ? await cfWorkers.deleteScript(client, o.id)
      : o.kind === 'd1'
        ? await cfD1.deleteDatabase(client, o.id)
        : o.kind === 'kv'
          ? await cfKv.deleteNamespace(client, o.id)
          : await cfQueues.deleteQueue(client, o.id);
  if (r.ok || r.error.message.includes('cf_status_404')) return { ok: true };
  return { ok: false, error: r.error.message };
};

export interface ReconcileResult {
  dryRun: boolean;
  scanned: { scripts: number; d1: number; kv: number; queues: number };
  orphans: Orphan[];
  deleted: Orphan[];
  failed: { orphan: Orphan; error: string }[];
}

/** Shared account + every connected tenant account, de-duplicated by account id. */
const credentialSets = async (env: Env): Promise<CloudflareCredentials[]> => {
  const out = [sharedCredentials(env)];
  const installs = await listActiveInstallations(env.DB);
  for (const i of installs.ok ? installs.value : []) {
    if (!i.cloudflareAccountId) continue;
    const creds = await resolveCloudflareCredentials(env, i.id);
    if (creds.source === 'installation' && !out.some((c) => c.accountId === creds.accountId)) {
      out.push(creds);
    }
  }
  return out;
};

export const reconcileOrphans = async (
  env: Env,
  opts: { dryRun: boolean; force?: boolean; actor?: string },
): Promise<ReconcileResult> => {
  const log = new Logger({ component: 'reconcile' });
  const result: ReconcileResult = {
    dryRun: opts.dryRun,
    scanned: { scripts: 0, d1: 0, kv: 0, queues: 0 },
    orphans: [],
    deleted: [],
    failed: [],
  };
  const rows = await readEnvRows(env.DB);
  for (const creds of await credentialSets(env)) {
    const client = new CFClient({
      accountId: creds.accountId,
      token: creds.token,
      fetcher: globalThis.fetch.bind(globalThis),
      logger: log,
      baseDelayMs: 100,
    });
    const res = await listAccountResources(client, log);
    const orphans = findOrphans(res, rows, { force: opts.force ?? false });
    result.scanned.scripts += res.scripts.length;
    result.scanned.d1 += res.d1.length;
    result.scanned.kv += res.kv.length;
    result.scanned.queues += res.queues.length;
    result.orphans.push(...orphans);
    log.info('reconcile_scan', {
      account: creds.accountId,
      orphans: orphans.length,
      dry_run: opts.dryRun,
    });
    if (!opts.dryRun) {
      await deleteAndAudit(env, client, { ...result, orphans }, opts.actor ?? 'reconciler');
    }
  }
  return result;
};

const deleteAndAudit = async (
  env: Env,
  client: CFClient,
  result: ReconcileResult,
  actor: string,
): Promise<void> => {
  for (const o of result.orphans) {
    const r = await deleteOne(client, o);
    if (r.ok) result.deleted.push(o);
    else result.failed.push({ orphan: o, error: r.error ?? 'unknown' });
    await appendAudit(env.DB, {
      id: ulid(),
      installationId: o.installationId ?? 'unknown',
      actor,
      action: r.ok ? 'reconcile.orphan_deleted' : 'reconcile.orphan_delete_failed',
      targetType: 'pr_environment',
      targetId: o.prEnvId ?? o.scriptName,
      metadata: { kind: o.kind, name: o.name, id: o.id, error: r.error },
    });
  }
};
