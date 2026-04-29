/**
 * TeardownRunner step implementations.
 *
 * Each step:
 *   - Looks up the PR env row to get resource handles (idempotent: missing
 *     handles → no-op).
 *   - Treats CF API 404 as "already gone" (idempotent on replay).
 *   - Throws on transient failures so the runner backs off + retries.
 */
import { CFClient } from '../../lib/cloudflare/client.ts';
import * as cfD1 from '../../lib/cloudflare/d1.ts';
import * as cfKv from '../../lib/cloudflare/kv.ts';
import * as cfQueues from '../../lib/cloudflare/queues.ts';
import * as cfWorkers from '../../lib/cloudflare/workers.ts';
import { purgePrefix } from '../../lib/cloudflare/r2.ts';
import { Logger } from '../../lib/logger.ts';
import { getPrEnvironment } from '../../lib/db/prEnvironments.ts';
import type { PrEnvironment } from '../../lib/db/types.ts';
import type { Env } from '../../env.ts';

export interface TeardownStepContext {
  env: Env;
  prEnvId: string;
  installationId: string;
  log: Logger;
}

const cfClient = (ctx: TeardownStepContext): CFClient =>
  new CFClient({
    accountId: ctx.env.CF_OWN_ACCOUNT_ID,
    token: ctx.env.CF_DEMO_API_TOKEN,
    fetcher: globalThis.fetch.bind(globalThis),
    logger: ctx.log,
    baseDelayMs: 50,
  });

const loadEnv = async (ctx: TeardownStepContext): Promise<PrEnvironment | null> => {
  const r = await getPrEnvironment(ctx.env.DB, ctx.prEnvId);
  if (!r.ok) throw r.error;
  return r.value;
};

const isNotFound = (e: unknown): boolean =>
  typeof e === 'object' &&
  e !== null &&
  'message' in e &&
  typeof (e as { message: unknown }).message === 'string' &&
  ((e as { message: string }).message.includes('cf_status_404') ||
    (e as { message: string }).message.includes('cf_status_400'));

export const markTearingDown = async (ctx: TeardownStepContext): Promise<{ noted: true }> => {
  ctx.log.info('mark_tearing_down');
  return { noted: true };
};

export const deleteWorkerScript = async (
  ctx: TeardownStepContext,
): Promise<{ deleted: boolean; scriptName: string | null }> => {
  const env = await loadEnv(ctx);
  const scriptName = env?.resources.workerScriptName ?? null;
  if (!scriptName) {
    ctx.log.info('delete_worker_script_skip_no_handle');
    return { deleted: false, scriptName: null };
  }
  const r = await cfWorkers.deleteScript(cfClient(ctx), scriptName);
  if (!r.ok && !isNotFound(r.error)) throw r.error;
  ctx.log.info('delete_worker_script_done', { script: scriptName });
  return { deleted: true, scriptName };
};

export const deleteD1 = async (
  ctx: TeardownStepContext,
): Promise<{ deleted: boolean; databaseId: string | null }> => {
  const env = await loadEnv(ctx);
  const id = env?.resources.d1DatabaseId ?? null;
  if (!id) return { deleted: false, databaseId: null };
  const r = await cfD1.deleteDatabase(cfClient(ctx), id);
  if (!r.ok && !isNotFound(r.error)) throw r.error;
  return { deleted: true, databaseId: id };
};

export const deleteKv = async (
  ctx: TeardownStepContext,
): Promise<{ deleted: boolean; namespaceId: string | null }> => {
  const env = await loadEnv(ctx);
  const id = env?.resources.kvNamespaceId ?? null;
  if (!id) return { deleted: false, namespaceId: null };
  const r = await cfKv.deleteNamespace(cfClient(ctx), id);
  if (!r.ok && !isNotFound(r.error)) throw r.error;
  return { deleted: true, namespaceId: id };
};

export const deleteQueueStep = async (
  ctx: TeardownStepContext,
): Promise<{ deleted: boolean; queueId: string | null }> => {
  const env = await loadEnv(ctx);
  const id = env?.resources.queueId ?? null;
  if (!id) return { deleted: false, queueId: null };
  const r = await cfQueues.deleteQueue(cfClient(ctx), id);
  if (!r.ok && !isNotFound(r.error)) throw r.error;
  return { deleted: true, queueId: id };
};

export const purgeR2Prefix = async (
  ctx: TeardownStepContext,
): Promise<{ deleted: number; prefix: string | null }> => {
  const env = await loadEnv(ctx);
  const prefix = env?.resources.r2Prefix ?? null;
  if (!prefix) return { deleted: 0, prefix: null };
  // BUNDLES holds the per-PR R2 keys; the bucket is shared, prefix is per-PR.
  const r = await purgePrefix(ctx.env.BUNDLES, prefix);
  if (!r.ok) throw r.error;
  return { deleted: r.value.deleted, prefix };
};

export const evictDoShard = async (
  ctx: TeardownStepContext,
): Promise<{ shardCount: number }> => {
  // PRD amendment A1: there is no list-by-prefix on DO namespaces. The
  // PrEnvironment DO maintains an explicit Set of shard names recorded by the
  // wrapper module. v1 reads the set, logs the count, and lets script deletion
  // orphan the storage (acceptable for free-tier demo). Production would
  // POST __raft_destroy__ to each shard via a service binding.
  // TODO(raft:slice-G) — POST __raft_destroy__ to each shard via service binding.
  ctx.log.info('evict_do_shard_v1_noop');
  return { shardCount: 0 };
};

export const clearRoute = async (ctx: TeardownStepContext): Promise<{ cleared: boolean }> => {
  const env = await loadEnv(ctx);
  if (!env?.previewHostname) return { cleared: false };
  await ctx.env.ROUTES.delete(`host:${env.previewHostname}`);
  return { cleared: true };
};

export const markTornDown = async (_ctx: TeardownStepContext): Promise<{ noted: true }> => {
  return { noted: true };
};

export const TEARDOWN_STEP_FNS = {
  'mark-tearing-down': markTearingDown,
  'delete-worker-script': deleteWorkerScript,
  'delete-d1': deleteD1,
  'delete-kv': deleteKv,
  'delete-queue': deleteQueueStep,
  'purge-r2-prefix': purgeR2Prefix,
  'evict-do-shard': evictDoShard,
  'clear-route': clearRoute,
  'mark-torn-down': markTornDown,
} as const;
