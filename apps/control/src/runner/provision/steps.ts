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
import { getInstallationToken } from '../../lib/github/app.ts';
import { getRepoTree } from '../../lib/github/contents.ts';
import {
  detectStatic,
  fetchAndInlineFiles,
  synthesizeWorker,
} from '../../lib/static-site/synth.ts';
import { upsertStickyComment } from '../../lib/github/comments.ts';

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
  /** Test-only knob for the upload-script propagation backoff. */
  propagationDelayMs?: number;
}

export type LoadConfigMode = 'static' | 'fallback';

export interface StaticSynthSummary {
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

export interface LoadConfigResult {
  wrangler: CustomerWranglerSummary;
  bundleR2Key: string;
  /**
   * How the bundle for this PR is being produced.
   *   'static'   — Raft synthesised a Worker from the customer's static
   *                files (HTML/CSS/etc.) at headSha. No CI required.
   *   'fallback' — No customer code source recognised; Raft uploads its
   *                placeholder so the lifecycle still completes end-to-end.
   * (`'bundle'` reserved for the customer-pushed bundle path landing in Track A.)
   */
  mode: LoadConfigMode;
  /** Set when mode === 'static'. The full synthesised module source. */
  staticBundleSource?: string;
  /** Compact summary for dashboard display. */
  staticSynth?: StaticSynthSummary;
}

export interface ProvisionResourcesResult {
  d1: { binding: string; database_id: string; database_name: string };
  kv: { binding: string; id: string; title: string };
  // queue_name is what user-Worker bindings reference; queue_id (UUID) is
  // what the CF API DELETE endpoint requires. Track both — bundle rewriter
  // uses the name; teardown uses the id.
  queue: { binding: string; queue_name: string; queue_id: string };
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
  /** GitHub comment id, if the sticky-comment post succeeded. */
  prCommentId?: number;
  /** True if a new comment was posted; false if an existing one was updated. */
  prCommentCreated?: boolean;
  /** Set when the GitHub call failed. The provision still succeeds. */
  prCommentSkippedReason?: string;
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
  // Try to materialise a real bundle from the customer's repo at headSha.
  // Order:
  //   1. If a wrangler config is present  → fall through to placeholder for
  //      now (customer-bundle path lands in Track A).
  //   2. If `index.html` is present at a recognised root → static synth.
  //   3. Otherwise → fallback placeholder (lifecycle still completes).
  ctx.log.info('load_config_start', { pr: ctx.params.prNumber, repo: ctx.params.repoFullName });

  const fallbackResult: LoadConfigResult = {
    wrangler: FALLBACK_WRANGLER,
    bundleR2Key: `bundles/${ctx.scriptName}.zip`,
    mode: 'fallback',
  };

  // GitHub failures here (bad/missing App private key, repo deleted, GH
  // outage) shouldn't leave the PR stuck — degrade to the placeholder
  // bundle and continue. The lifecycle still completes; the operator sees
  // a warning in the audit log + dashboard. If the customer fixes their
  // App install, the next push triggers a fresh provision that picks up
  // the real code.
  let token: string;
  try {
    token = await getInstallationToken(
      ctx.env.CACHE,
      { appId: ctx.env.GITHUB_APP_ID, privateKeyPem: ctx.env.GITHUB_APP_PRIVATE_KEY },
      ctx.params.installationId,
    );
  } catch (e) {
    ctx.log.warn('load_config_install_token_failed_degrading', { error: String(e) });
    return fallbackResult;
  }

  let tree;
  try {
    tree = await getRepoTree(token, ctx.params.repoFullName, ctx.params.headSha);
  } catch (e) {
    ctx.log.warn('load_config_get_tree_failed_degrading', { error: String(e) });
    return fallbackResult;
  }

  const detection = detectStatic(tree);
  if (!detection.isStatic) {
    ctx.log.info('load_config_no_static_match', { tree_truncated: tree.truncated });
    return fallbackResult;
  }

  const synth = await fetchAndInlineFiles(token, ctx.params.repoFullName, detection);
  if (synth.files.length === 0) {
    ctx.log.warn('load_config_static_zero_files', { warnings: synth.warnings });
    return fallbackResult;
  }
  const source = synthesizeWorker(synth);
  ctx.log.info('load_config_static_synth_ok', {
    files: synth.files.length,
    bytes: synth.totalBytes,
    warnings_count: synth.warnings.length,
  });

  return {
    wrangler: { ...FALLBACK_WRANGLER, main_module: 'worker.js' },
    bundleR2Key: `bundles/${ctx.scriptName}.zip`,
    mode: 'static',
    staticBundleSource: source,
    staticSynth: {
      fileCount: synth.files.length,
      totalBytes: synth.totalBytes,
      warnings: synth.warnings,
    },
  };
};

const cfClientFromCtx = (ctx: StepContext): CFClient =>
  new CFClient({
    accountId: ctx.env.CF_OWN_ACCOUNT_ID,
    token: ctx.env.CF_API_TOKEN,
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
    queue: {
      binding: 'QUEUE',
      queue_name: queue.value.queue_name,
      queue_id: queue.value.queue_id,
    },
    r2Prefix: `tenants/${ctx.params.installationId}/${ctx.scope}/`,
  };
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, {
    d1DatabaseId: result.d1.database_id,
    kvNamespaceId: result.kv.id,
    // Store the UUID (required by `DELETE /queues/{id}` at teardown), NOT
    // the human-readable queue_name. The user-Worker binding still uses
    // queue_name via the bundle rewriter — see ProvisionResourcesResult.
    queueId: result.queue.queue_id,
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
  const moduleSource = config.mode === 'static' && config.staticBundleSource
    ? config.staticBundleSource
    : PLACEHOLDER_BUNDLE_SOURCE;
  const inputs: BundleInputs = {
    wrangler: config.wrangler,
    modules: [
      {
        name: config.wrangler.main_module,
        content: moduleSource,
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

// CF error codes that mean "the binding's resource hasn't propagated yet"
// — fixable by retrying after a short delay (typically 2-5s for D1/KV/Queue).
const PROPAGATION_ERROR_CODES = ['10181', '10041', '100100'] as const;
const UPLOAD_PROPAGATION_RETRIES = 5;
const UPLOAD_PROPAGATION_DELAY_MS = 2000;

const isPropagationLag = (e: CodedError): boolean => {
  const body = (e.details as { body?: string } | undefined)?.body ?? '';
  return PROPAGATION_ERROR_CODES.some((code) => body.includes(`"code":${code}`));
};

export const uploadScript = async (ctx: StepContext): Promise<UploadScriptResult> => {
  const { config, provisioned } = requirePrior(ctx);
  if (!cfWorkers.validateScriptName(ctx.scriptName)) {
    throw new NonRetryableError('E_VALIDATION', `invalid script name: ${ctx.scriptName}`);
  }
  const rewritten = buildRewrite(ctx, config, provisioned);
  const client = cfClientFromCtx(ctx);
  const params: Parameters<typeof cfWorkers.uploadScript>[1] = {
    scriptName: ctx.scriptName,
    mainModule: config.wrangler.main_module,
    modules: rewritten.modules,
    compatibilityDate: config.wrangler.compatibility_date,
    compatibilityFlags: config.wrangler.compatibility_flags ?? [],
    bindings: rewritten.bindings as cfWorkers.WorkerBinding[],
    // Free-tier substitution: tail_consumers requires Workers Paid (CF error
    // code 100150). v1 omits Tail Workers; live logs in the dashboard work
    // via the LogTail DO over hibernatable WS. Re-enable in v2 when on a
    // paid plan or when raft-tail is bound as a service rather than a tail.
    tags: [
      `installation:${ctx.params.installationId}`,
      `repo:${ctx.params.repoFullName}`,
      `pr:${ctx.params.prNumber}`,
    ],
  };
  for (let attempt = 0; attempt < UPLOAD_PROPAGATION_RETRIES; attempt++) {
    const r = await cfWorkers.uploadScript(client, params);
    if (r.ok) {
      await setResourceHandles(ctx.env.DB, ctx.prEnvId, { workerScriptName: ctx.scriptName });
      // *.workers.dev exposure is disabled by default for REST-uploaded
      // scripts. Without this the dispatcher's forwarded fetch hits CF's
      // empty-subdomain placeholder. Failure here is logged but non-fatal:
      // the script is uploaded, the dashboard still works via direct DO RPC.
      const sub = await cfWorkers.enableSubdomain(client, ctx.scriptName);
      if (!sub.ok) ctx.log.warn('enable_subdomain_failed', { error: sub.error.message });
      return r.value.etag === undefined
        ? { scriptId: r.value.id }
        : { scriptId: r.value.id, etag: r.value.etag };
    }
    if (!isPropagationLag(r.error) || attempt === UPLOAD_PROPAGATION_RETRIES - 1) {
      throw r.error;
    }
    const delay = ctx.propagationDelayMs ?? UPLOAD_PROPAGATION_DELAY_MS;
    ctx.log.warn('upload_script_propagation_retry', { attempt: attempt + 1, delay_ms: delay });
    await new Promise((res) => setTimeout(res, delay));
  }
  throw new NonRetryableError('E_CF_API', 'upload_script: propagation_exhausted');
};

const buildPreviewCommentBody = (
  ctx: StepContext,
  config: LoadConfigResult,
): string => {
  const dashUrl = `https://raft-control.${ctx.env.CF_WORKERS_SUBDOMAIN}/dashboard/pr/${encodeURIComponent(ctx.prEnvId)}`;
  const bundleLine = config.mode === 'static' && config.staticSynth
    ? `**Bundle:** \`static-synth\` · ${config.staticSynth.fileCount} file${config.staticSynth.fileCount === 1 ? '' : 's'} · ${(config.staticSynth.totalBytes / 1024).toFixed(1)} KB`
    : `**Bundle:** \`placeholder\` (no \`index.html\` found and customer bundle not yet uploaded)`;
  return [
    `### 🛟 Raft preview ready`,
    ``,
    `**Preview:** ${ctx.previewHostname}/`,
    ``,
    bundleLine,
    `**Scope:** \`${ctx.scope}\` · **Worker:** \`${ctx.scriptName}\``,
    ``,
    `[Open in dashboard ↗](${dashUrl})`,
    ``,
    `<sub>Per-PR isolated environment provisioned by [Raft](https://github.com/Adi-gitX/Rift) on Cloudflare Workers free tier. Auto-torn-down on PR close.</sub>`,
  ].join('\n');
};

export const routeAndComment = async (ctx: StepContext): Promise<RouteAndCommentResult> => {
  // Path-based route used by raft-dispatcher (free-tier: no wildcard subdomain).
  const routeKey = `route:${ctx.scope}`;
  await ctx.env.ROUTES.put(routeKey, ctx.scriptName, {
    metadata: { installationId: ctx.params.installationId, prNumber: ctx.params.prNumber },
  });
  // Reverse index used by the tail-events queue consumer to map script → PR env.
  await ctx.env.ROUTES.put(`script:${ctx.scriptName}:pr`, ctx.prEnvId);
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, { previewHostname: ctx.previewHostname });

  // Sticky PR comment. GitHub failures here are non-fatal: the preview is
  // already live; missing the comment is just a UX regression. The next
  // pull_request.synchronize will get another shot.
  const config = ctx.prior['load-config'] as LoadConfigResult | undefined;
  const result: RouteAndCommentResult = {
    hostname: ctx.previewHostname,
    scriptName: ctx.scriptName,
    routeKvKey: routeKey,
  };
  if (!config) {
    result.prCommentSkippedReason = 'load-config result missing';
    return result;
  }
  try {
    const token = await getInstallationToken(
      ctx.env.CACHE,
      { appId: ctx.env.GITHUB_APP_ID, privateKeyPem: ctx.env.GITHUB_APP_PRIVATE_KEY },
      ctx.params.installationId,
    );
    const body = buildPreviewCommentBody(ctx, config);
    const upsert = await upsertStickyComment({
      token,
      ownerRepo: ctx.params.repoFullName,
      issueNumber: ctx.params.prNumber,
      body,
      marker: 'preview',
    });
    await setResourceHandles(ctx.env.DB, ctx.prEnvId, { prCommentId: upsert.commentId });
    result.prCommentId = upsert.commentId;
    result.prCommentCreated = upsert.created;
    ctx.log.info('pr_comment_upserted', { comment_id: upsert.commentId, created: upsert.created });
  } catch (e) {
    ctx.log.warn('pr_comment_skipped', { error: String(e) });
    result.prCommentSkippedReason = String(e);
  }
  return result;
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
