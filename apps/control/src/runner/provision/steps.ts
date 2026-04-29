/**
 * ProvisionRunner step implementations.
 *
 * Each step takes a `StepContext`, returns a JSON-serializable result that
 * the runner persists to DO storage under `step:<name>`. Throwing means
 * "retryable" (the runner will back off + retry); throwing
 * `NonRetryableError` short-circuits to compensating teardown.
 */
import { CodedError, NonRetryableError } from '@raft/shared-types';
import type { Env, ProvisionPRParams } from '../../env.ts';
import { CFClient } from '../../lib/cloudflare/client.ts';
import * as cfD1 from '../../lib/cloudflare/d1.ts';
import * as cfKv from '../../lib/cloudflare/kv.ts';
import * as cfQueues from '../../lib/cloudflare/queues.ts';
import * as cfWorkers from '../../lib/cloudflare/workers.ts';
import { rewriteBundle } from '../../lib/bundle-rewriter/index.ts';
import type {
  BundleInputs,
  CustomerWranglerSummary,
  RewrittenBundle,
} from '../../lib/bundle-rewriter/types.ts';
import { type Logger } from '../../lib/logger.ts';
import { setResourceHandles } from '../../lib/db/prEnvironments.ts';

export interface StepContext {
  env: Env;
  params: ProvisionPRParams;
  prEnvId: string;
  scope: string;
  scriptName: string;
  previewHostname: string;
  log: Logger;
  /** When omitted, CFClient falls back to globalThis.fetch. */
  fetcher: typeof fetch;
  /** Pre-stored step results keyed by step name (idempotent replay). */
  prior: Record<string, unknown>;
}

export interface LoadConfigResult {
  wrangler: CustomerWranglerSummary;
  bundleR2Key: string;
}

export interface ProvisionResourcesResult {
  d1: { binding: string; database_id: string; database_name: string };
  kv: { binding: string; id: string; title: string };
  queue: { binding: string; queue_name: string };
  r2Prefix: string;
}

export interface RewriteBundleResult {
  bindings: unknown[];
  modulesCount: number;
  warnings: string[];
}

export interface UploadScriptResult {
  scriptId: string;
  etag?: string;
}

export interface RouteAndCommentResult {
  hostname: string;
  scriptName: string;
  routeKvKey: string;
}

const FALLBACK_WRANGLER: CustomerWranglerSummary = {
  main_module: 'worker.js',
  compatibility_date: '2026-04-29',
  bindings: [
    { type: 'd1', binding: 'DB', database_id: 'placeholder', database_name: 'placeholder' },
    { type: 'kv', binding: 'KV', id: 'placeholder' },
    { type: 'queue', binding: 'QUEUE', queue_name: 'placeholder' },
  ],
  do_classes_to_shard: [],
};

const PLACEHOLDER_BUNDLE_SOURCE = `export default {
  async fetch(req, env) {
    return new Response('hello from raft preview ' + (env.RAFT_PR_SCOPE ?? 'unknown'), {
      headers: { 'content-type': 'text/plain' },
    });
  },
};
`;

export const loadConfig = async (ctx: StepContext): Promise<LoadConfigResult> => {
  // TODO(raft:slice-G) — in production, fetch `.raft.json` from GitHub at
  // payload.headSha and parse with Zod. v1 returns a sane default.
  ctx.log.info('load_config', { pr: ctx.params.prNumber });
  return { wrangler: FALLBACK_WRANGLER, bundleR2Key: `bundles/${ctx.scriptName}.zip` };
};

const cfClientFromCtx = (ctx: StepContext): CFClient =>
  new CFClient({
    accountId: ctx.env.CF_OWN_ACCOUNT_ID,
    token: ctx.env.CF_DEMO_API_TOKEN,
    fetcher: ctx.fetcher,
    logger: ctx.log,
    baseDelayMs: 50,
  });

export const provisionResources = async (ctx: StepContext): Promise<ProvisionResourcesResult> => {
  const client = cfClientFromCtx(ctx);
  ctx.log.info('provision_resources', { script: ctx.scriptName });
  const [d1, kv, queue] = await Promise.all([
    cfD1.createDatabase(client, `${ctx.scriptName}-db`),
    cfKv.createNamespace(client, `${ctx.scriptName}-kv`),
    cfQueues.createQueue(client, `${ctx.scriptName}-q`),
  ]);
  if (!d1.ok) throw d1.error;
  if (!kv.ok) throw kv.error;
  if (!queue.ok) throw queue.error;

  const result: ProvisionResourcesResult = {
    d1: { binding: 'DB', database_id: d1.value.uuid, database_name: d1.value.name },
    kv: { binding: 'KV', id: kv.value.id, title: kv.value.title },
    queue: { binding: 'QUEUE', queue_name: queue.value.queue_name },
    r2Prefix: `tenants/${ctx.params.installationId}/${ctx.scope}/`,
  };
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, {
    d1DatabaseId: result.d1.database_id,
    kvNamespaceId: result.kv.id,
    queueId: result.queue.queue_name,
    r2Prefix: result.r2Prefix,
    doNamespaceSeed: ctx.scope,
  });
  return result;
};

const requirePrior = (ctx: StepContext): { config: LoadConfigResult; provisioned: ProvisionResourcesResult } => {
  const config = ctx.prior['load-config'] as LoadConfigResult | undefined;
  const provisioned = ctx.prior['provision-resources'] as ProvisionResourcesResult | undefined;
  if (!config || !provisioned) throw new NonRetryableError('E_INTERNAL', 'prior steps missing');
  return { config, provisioned };
};

const buildRewrite = (
  ctx: StepContext,
  config: LoadConfigResult,
  provisioned: ProvisionResourcesResult,
): RewrittenBundle => {
  const inputs: BundleInputs = {
    wrangler: config.wrangler,
    modules: [
      {
        name: config.wrangler.main_module,
        content: PLACEHOLDER_BUNDLE_SOURCE,
        contentType: 'application/javascript+module',
      },
    ],
    resources: {
      d1: [provisioned.d1],
      kv: [provisioned.kv],
      queues: [provisioned.queue],
      r2Prefix: provisioned.r2Prefix,
    },
    scope: ctx.scope,
    internalDispatchSecret: ctx.env.INTERNAL_DISPATCH_SECRET,
  };
  return rewriteBundle(inputs);
};

export const rewriteBundleStep = async (ctx: StepContext): Promise<RewriteBundleResult> => {
  const { config, provisioned } = requirePrior(ctx);
  const rewritten = buildRewrite(ctx, config, provisioned);
  ctx.log.info('rewrite_bundle', { warnings: rewritten.warnings });
  return {
    bindings: rewritten.bindings,
    modulesCount: rewritten.modules.length,
    warnings: rewritten.warnings,
  };
};

export const uploadScript = async (ctx: StepContext): Promise<UploadScriptResult> => {
  const { config, provisioned } = requirePrior(ctx);
  if (!cfWorkers.validateScriptName(ctx.scriptName)) {
    throw new NonRetryableError('E_VALIDATION', `invalid script name: ${ctx.scriptName}`);
  }
  const rewritten = buildRewrite(ctx, config, provisioned);
  const client = cfClientFromCtx(ctx);
  const r = await cfWorkers.uploadScript(client, {
    scriptName: ctx.scriptName,
    mainModule: config.wrangler.main_module,
    modules: rewritten.modules,
    compatibilityDate: config.wrangler.compatibility_date,
    compatibilityFlags: config.wrangler.compatibility_flags ?? [],
    bindings: rewritten.bindings as cfWorkers.WorkerBinding[],
    tailConsumers: [{ service: 'raft-tail' }],
    tags: [
      `installation:${ctx.params.installationId}`,
      `repo:${ctx.params.repoFullName}`,
      `pr:${ctx.params.prNumber}`,
    ],
  });
  if (!r.ok) throw r.error;
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, { workerScriptName: ctx.scriptName });
  return r.value.etag === undefined
    ? { scriptId: r.value.id }
    : { scriptId: r.value.id, etag: r.value.etag };
};

export const routeAndComment = async (ctx: StepContext): Promise<RouteAndCommentResult> => {
  const routeKey = `host:${ctx.previewHostname}`;
  await ctx.env.ROUTES.put(routeKey, ctx.scriptName, {
    metadata: { installationId: ctx.params.installationId, prNumber: ctx.params.prNumber },
  });
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, { previewHostname: ctx.previewHostname });
  // TODO(raft:slice-G) — post sticky PR comment via GitHub install token.
  return {
    hostname: ctx.previewHostname,
    scriptName: ctx.scriptName,
    routeKvKey: routeKey,
  };
};

export const STEP_FNS = {
  'load-config': loadConfig,
  'provision-resources': provisionResources,
  'rewrite-bundle': rewriteBundleStep,
  'upload-script': uploadScript,
  'route-and-comment': routeAndComment,
} as const;

export interface StepResultMap {
  'load-config': LoadConfigResult;
  'provision-resources': ProvisionResourcesResult;
  'rewrite-bundle': RewriteBundleResult;
  'upload-script': UploadScriptResult;
  'route-and-comment': RouteAndCommentResult;
}

export const stepError = (e: unknown): CodedError | NonRetryableError =>
  e instanceof CodedError ? e : new CodedError('E_INTERNAL', String(e));
