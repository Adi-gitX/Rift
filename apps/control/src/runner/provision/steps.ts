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
import { getRepo, repoIdOf } from '../../lib/db/repos.ts';
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

export type LoadConfigMode = 'customer-bundle' | 'static' | 'fallback';

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
  /** The actual main_module name in the rewritten bundle. For customer-bundle
   *  mode this is the customer's main module (e.g. "index.js"); for
   *  static / fallback this is what the synth template emits. */
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
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

/**
 * Worker uploaded when neither customer-bundle nor static-synth applies.
 * Returns 503 with an actionable message — does NOT silently serve fake
 * content. The PR sticky comment also calls this out as a configuration
 * problem (see buildPreviewCommentBody).
 */
const PLACEHOLDER_BUNDLE_SOURCE = `export default {
  async fetch(req, env) {
    const message = [
      'Preview environment is not configured for this repository.',
      '',
      'To deploy real previews, do one of:',
      '',
      '  1. Add a wrangler config (wrangler.jsonc / .json / .toml) and the Raft GitHub Action',
      '     workflow to upload your built Worker bundle on every PR.',
      '',
      '  2. Add an index.html under /, /public, /dist, /build, or /site for static-site',
      '     deployments (no GitHub Action required).',
      '',
      'Scope: ' + (env.RAFT_PR_SCOPE ?? 'unknown'),
    ].join('\\n');
    return new Response(message, {
      status: 503,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'x-raft-preview': 'unconfigured',
      },
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

  // Smart-redeploy short-circuit: if a prior provision against the same
  // headSha already succeeded, the bundle is byte-identical. Skip the GH
  // round-trip + synth and reuse the cached source. This makes
  // doc-only PR updates and webhook replays effectively free.
  const cacheKey = `bundle-cache:${ctx.params.repoFullName}@${ctx.params.headSha}`;
  const cached = await ctx.env.CACHE.get(cacheKey, 'json') as
    | { mode: LoadConfigMode; staticBundleSource?: string; staticSynth?: StaticSynthSummary }
    | null;
  if (cached) {
    ctx.log.info('load_config_cache_hit', { headSha: ctx.params.headSha, mode: cached.mode });
    if (cached.mode === 'static' && cached.staticBundleSource) {
      const result: LoadConfigResult = {
        wrangler: { ...FALLBACK_WRANGLER, main_module: 'worker.js' },
        bundleR2Key: `bundles/${ctx.scriptName}.zip`,
        mode: 'static',
        staticBundleSource: cached.staticBundleSource,
      };
      if (cached.staticSynth) result.staticSynth = cached.staticSynth;
      return result;
    }
    if (cached.mode === 'customer-bundle') {
      return {
        wrangler: { ...FALLBACK_WRANGLER, main_module: 'worker.js' },
        bundleR2Key: `bundles/${ctx.scriptName}.zip`,
        mode: 'customer-bundle',
      };
    }
    return fallbackResult;
  }

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

  // Detection precedence:
  //   1. wrangler.{jsonc,json,toml} present → customer-bundle (Track A,
  //      requires the GH Action to upload a built dist/)
  //   2. index.html under one of STATIC_ROOTS → static-synth (no customer setup)
  //   3. otherwise → fallback placeholder
  const hasWranglerConfig = tree.tree.some(
    (e) => e.type === 'blob' && /^wrangler\.(jsonc|json|toml)$/.test(e.path),
  );
  if (hasWranglerConfig) {
    ctx.log.info('load_config_customer_bundle_detected');
    const customerResult: LoadConfigResult = {
      wrangler: { ...FALLBACK_WRANGLER, main_module: 'worker.js' },
      bundleR2Key: `bundles/${ctx.scriptName}.zip`,
      mode: 'customer-bundle',
    };
    // Cache the mode decision so re-runs against the same SHA short-circuit.
    await ctx.env.CACHE.put(cacheKey, JSON.stringify({ mode: 'customer-bundle' }), {
      expirationTtl: 86400,
    });
    return customerResult;
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
  // Compute the per-scope auth token. Mirrors raft-dispatcher's signScope:
  // base64url-truncated HMAC-SHA256 of "raft-preview:{scope}". The
  // synthesized worker checks ?raft_t= or the raft_t cookie.
  const expectedToken = await signScopeForSynth(ctx.scope, ctx.env.INTERNAL_DISPATCH_SECRET);
  const source = synthesizeWorker(synth, { expectedToken });
  ctx.log.info('load_config_static_synth_ok', {
    files: synth.files.length,
    bytes: synth.totalBytes,
    warnings_count: synth.warnings.length,
  });

  const finalResult: LoadConfigResult = {
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
  // Cache for smart-redeploy. 24h TTL — long enough to cover doc-only PR
  // updates and webhook replays, short enough that stale Worker source
  // never lingers across major refactors that happen to keep the same SHA
  // (impossible in practice, but cheap insurance).
  await ctx.env.CACHE.put(cacheKey, JSON.stringify({
    mode: finalResult.mode,
    staticBundleSource: finalResult.staticBundleSource,
    staticSynth: finalResult.staticSynth,
  }), { expirationTtl: 86400 });
  return finalResult;
};

const cfClientFromCtx = (ctx: StepContext): CFClient =>
  new CFClient({
    accountId: ctx.env.CF_OWN_ACCOUNT_ID,
    token: ctx.env.CF_API_TOKEN,
    fetcher: ctx.fetcher,
    logger: ctx.log,
    baseDelayMs: 50,
  });

/**
 * Compute the same per-scope HMAC token raft-dispatcher emits, so the
 * synthesized worker can verify requests came through the dispatcher.
 * Keep this function byte-for-byte aligned with apps/dispatcher/src/index.ts:signScope.
 */
const signScopeForSynth = async (scope: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`raft-preview:${scope}`)));
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(sig[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// ── Track A: customer-Worker bundle ingestion ──────────────────────────────

export interface AwaitBundleResult {
  /** Modes that need a customer bundle from the GH-Action upload. */
  source: 'customer-bundle' | 'static-synth' | 'placeholder';
  /** Set when source==='customer-bundle'; the BUNDLES_KV key carrying the zip. */
  bundleKey?: string;
  /** Set when source==='customer-bundle'; bytes of the uploaded archive. */
  bundleBytes?: number;
  /** SHA-256 of the bundle bytes (hex). Used for smart-redeploy short-circuit. */
  bundleEtag?: string;
  /** Wall-clock waiting time, ms — surfaced in the dashboard. */
  waitedMs: number;
}

/**
 * KV key for the customer-uploaded bundle. Mirrors the upload endpoint in
 * routes/api.ts which uses `bundle:{repoId}:{headSha}` where repoId is the
 * fully-qualified `{installationId}:{repoFullName}`. Keep these identical or
 * the runner won't find what the GH Action just pushed.
 */
export const bundleKvKey = (installationId: string, repoFullName: string, headSha: string): string =>
  `bundle:${installationId}:${repoFullName}:${headSha}`;

export interface UploadedBundlePayload {
  wrangler: {
    main_module?: string;
    compatibility_date?: string;
    compatibility_flags?: string[];
    bindings?: unknown[];
  };
  modules: Array<{
    name: string;
    /** Base64-encoded module bytes. */
    content_b64: string;
    type?: string;
  }>;
  uploadedAt?: number;
  bytes?: number;
}

const AWAIT_BUNDLE_TIMEOUT_MS = 5 * 60 * 1000;
const AWAIT_BUNDLE_POLL_MS = 2000;

/**
 * Wait for the customer's GH Action to upload the bundle. The upload
 * endpoint also wakes the PrEnvironment DO directly (push semantics), but
 * we keep this poll loop as the durable fallback in case the wake-up
 * misses (DO storage is the source of truth).
 *
 * Static / fallback modes return immediately — there's nothing to wait for.
 */
export const awaitBundle = async (ctx: StepContext): Promise<AwaitBundleResult> => {
  const config = ctx.prior['load-config'] as LoadConfigResult | undefined;
  const startedAt = Date.now();
  if (!config || config.mode !== 'customer-bundle') {
    return {
      source: config?.mode === 'static' ? 'static-synth' : 'placeholder',
      waitedMs: 0,
    };
  }
  const key = bundleKvKey(ctx.params.installationId, ctx.params.repoFullName, ctx.params.headSha);
  while (Date.now() - startedAt < AWAIT_BUNDLE_TIMEOUT_MS) {
    const meta = await ctx.env.BUNDLES_KV.getWithMetadata<{ etag?: string; bytes?: number }>(key);
    if (meta.value) {
      return {
        source: 'customer-bundle',
        bundleKey: key,
        bundleBytes: meta.metadata?.bytes ?? meta.value.length,
        ...(meta.metadata?.etag ? { bundleEtag: meta.metadata.etag } : {}),
        waitedMs: Date.now() - startedAt,
      };
    }
    await new Promise((r) => setTimeout(r, AWAIT_BUNDLE_POLL_MS));
  }
  // Throw → alarm reschedules with backoff. Use NonRetryable so we
  // short-circuit to failure once the timeout cap is reached rather than
  // burning the runner's 5 attempts.
  throw new NonRetryableError(
    'E_VALIDATION',
    `bundle upload timed out after ${AWAIT_BUNDLE_TIMEOUT_MS}ms — did the GH Action run? POST to /api/v1/bundles/upload`,
  );
};

/** Load the previously-stored customer bundle from KV, parse + decode it. */
const loadCustomerBundle = async (
  env: Env,
  key: string,
): Promise<{ wrangler: UploadedBundlePayload['wrangler']; modules: Array<{ name: string; content: Uint8Array; type: string }> } | null> => {
  const text = await env.BUNDLES_KV.get(key);
  if (!text) return null;
  let payload: UploadedBundlePayload;
  try {
    payload = JSON.parse(text) as UploadedBundlePayload;
  } catch {
    return null;
  }
  const decode = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  return {
    wrangler: payload.wrangler ?? {},
    modules: payload.modules.map((m) => ({
      name: m.name,
      content: decode(m.content_b64),
      type: m.type ?? 'application/javascript+module',
    })),
  };
};

export const provisionResources = async (ctx: StepContext): Promise<ProvisionResourcesResult> => {
  const client = cfClientFromCtx(ctx);
  ctx.log.info('provision_resources', { script: ctx.scriptName });
  // Inlined idempotent provisioning — bypass the cf-lib findOrCreate wrappers
  // so we can log exactly what's happening at each step. CF returns
  // wildly different "already exists" shapes per resource type (D1: 400+7502,
  // KV: 400+10014, Queue: 409+11009), so we just LIST first and only create
  // if not present. Names are deterministic per PR.
  const d1Name = `${ctx.scriptName}-db`;
  const kvTitle = `${ctx.scriptName}-kv`;
  const queueName = `${ctx.scriptName}-q`;

  const readListBody = async (path: string, label: string): Promise<unknown[] | null> => {
    const r = await client.raw({ method: 'GET', path });
    if (!r.ok) { ctx.log.warn('list_failed', { label, error: r.error.message }); return null; }
    try {
      const text = await r.value.text();
      const data = JSON.parse(text) as { result?: unknown };
      return Array.isArray(data.result) ? data.result : null;
    } catch (e) { ctx.log.warn('list_parse_failed', { label, error: String(e) }); return null; }
  };

  const [d1List, kvList, queueList] = await Promise.all([
    readListBody(`/d1/database?name=${encodeURIComponent(d1Name)}&per_page=100`, 'd1'),
    readListBody('/storage/kv/namespaces?per_page=100', 'kv'),
    readListBody('/queues?per_page=100', 'queues'),
  ]);

  const existingD1 = (d1List as Array<{ uuid?: string; name?: string }> | null)?.find((d) => d.name === d1Name);
  const existingKv = (kvList as Array<{ id?: string; title?: string }> | null)?.find((n) => n.title === kvTitle);
  const existingQueue = (queueList as Array<{ queue_id?: string; queue_name?: string }> | null)?.find((q) => q.queue_name === queueName);

  const d1 = existingD1?.uuid && existingD1.name
    ? { ok: true as const, value: { uuid: existingD1.uuid, name: existingD1.name } }
    : await cfD1.createDatabase(client, d1Name);
  const kv = existingKv?.id && existingKv.title
    ? { ok: true as const, value: { id: existingKv.id, title: existingKv.title } }
    : await cfKv.createNamespace(client, kvTitle);
  const queue = existingQueue?.queue_id && existingQueue.queue_name
    ? { ok: true as const, value: { queue_id: existingQueue.queue_id, queue_name: existingQueue.queue_name } }
    : await cfQueues.createQueue(client, queueName);
  if (!d1.ok) { ctx.log.error('provision_d1_failed', { msg: d1.error.message }); throw d1.error; }
  if (!kv.ok) { ctx.log.error('provision_kv_failed', { msg: kv.error.message }); throw kv.error; }
  if (!queue.ok) { ctx.log.error('provision_queue_failed', { msg: queue.error.message }); throw queue.error; }

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
  customerBundle: Awaited<ReturnType<typeof loadCustomerBundle>>,
): RewrittenBundle => {
  let modules: BundleInputs['modules'];
  let mainModule = config.wrangler.main_module;
  let wrangler = config.wrangler;
  if (config.mode === 'customer-bundle' && customerBundle && customerBundle.modules.length > 0) {
    // Customer-uploaded modules. Use the customer's wrangler config so DO
    // class names + extra bindings are honoured by the rewriter.
    modules = customerBundle.modules.map((m) => ({
      name: m.name,
      content: m.content,
      contentType: m.type,
    }));
    mainModule = customerBundle.wrangler.main_module ?? modules[0]?.name ?? 'worker.js';
    // Prefer customer's wrangler when fields are present; fall back to FALLBACK_WRANGLER.
    wrangler = {
      main_module: mainModule,
      compatibility_date: customerBundle.wrangler.compatibility_date ?? config.wrangler.compatibility_date,
      ...(customerBundle.wrangler.compatibility_flags ? { compatibility_flags: customerBundle.wrangler.compatibility_flags } : {}),
      bindings: (customerBundle.wrangler.bindings ?? config.wrangler.bindings) as typeof config.wrangler.bindings,
      do_classes_to_shard: config.wrangler.do_classes_to_shard,
    };
  } else {
    const moduleSource = config.mode === 'static' && config.staticBundleSource
      ? config.staticBundleSource
      : PLACEHOLDER_BUNDLE_SOURCE;
    modules = [
      { name: mainModule, content: moduleSource, contentType: 'application/javascript+module' },
    ];
  }

  const inputs: BundleInputs = {
    wrangler,
    modules,
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
  const awaited = ctx.prior['await-bundle'] as AwaitBundleResult | undefined;
  let customerBundle: Awaited<ReturnType<typeof loadCustomerBundle>> = null;
  if (awaited?.source === 'customer-bundle' && awaited.bundleKey) {
    customerBundle = await loadCustomerBundle(ctx.env, awaited.bundleKey);
    if (!customerBundle) {
      throw new NonRetryableError('E_INTERNAL', `customer bundle disappeared from KV: ${awaited.bundleKey}`);
    }
  }
  const rewritten = buildRewrite(ctx, config, provisioned, customerBundle);
  // Determine the main_module that actually went into the rewritten bundle.
  // For customer-bundle this comes from the customer's wrangler.json (or
  // the first module if missing); for static/fallback it's `worker.js`.
  const mainModule = customerBundle?.wrangler.main_module
    ?? customerBundle?.modules[0]?.name
    ?? config.wrangler.main_module;
  const compatibilityDate = customerBundle?.wrangler.compatibility_date ?? config.wrangler.compatibility_date;
  ctx.log.info('rewrite_bundle', {
    source: awaited?.source ?? 'unknown',
    main_module: mainModule,
    modules_count: rewritten.modules.length,
    warnings: rewritten.warnings,
  });
  const result: RewriteBundleResult = {
    bindings: rewritten.bindings,
    modulesCount: rewritten.modules.length,
    warnings: rewritten.warnings,
    mainModule,
    compatibilityDate,
  };
  if (customerBundle?.wrangler.compatibility_flags) {
    result.compatibilityFlags = customerBundle.wrangler.compatibility_flags;
  }
  return result;
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

// ── fork-base-db step ──────────────────────────────────────────────────────

export interface ForkBaseDbResult {
  source: 'skipped' | 'forked';
  /** When source==='forked', the source DB id we read from. */
  baseDatabaseId?: string;
  /** When source==='forked', byte length of the SQL dump. */
  sqlBytes?: number;
  /** Reason for skip: 'no-base-d1' | 'demo-base-equals-target' | 'self-fork-blocked'. */
  reason?: string;
}

const sha256Hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

/**
 * Seed the per-PR D1 with the base-branch DB's schema + data.
 * Source preference:
 *   1. repo.baseD1Id   (explicit per-repo configuration, future)
 *   2. RAFT_DEMO_BASE_D1_ID  (demo-mode default)
 * Skipped if neither, or if the source equals the target (self-fork guard).
 */
export const forkBaseDb = async (ctx: StepContext): Promise<ForkBaseDbResult> => {
  const { provisioned } = requirePrior(ctx);
  const repoId = repoIdOf(ctx.params.installationId, ctx.params.repoFullName);
  const repoRow = await getRepo(ctx.env.DB, repoId);
  const baseFromRepo = repoRow.ok && repoRow.value?.baseD1Id ? repoRow.value.baseD1Id : null;
  const baseFromEnv = ctx.env.RAFT_DEMO_BASE_D1_ID ?? null;
  const baseId = baseFromRepo ?? baseFromEnv;

  if (!baseId) {
    ctx.log.info('fork_base_db_skipped', { reason: 'no-base-d1' });
    return { source: 'skipped', reason: 'no-base-d1' };
  }
  if (baseId === provisioned.d1.database_id) {
    ctx.log.warn('fork_base_db_skipped', { reason: 'self-fork-blocked' });
    return { source: 'skipped', reason: 'self-fork-blocked' };
  }

  // Export-then-import via CF REST. Failures (source DB missing, export
  // timeout, CF rate limit) are non-fatal — we degrade to "empty per-PR
  // DB" rather than failing the whole provision. The PR env is still
  // usable, just unseeded.
  const client = cfClientFromCtx(ctx);
  const sql = await cfD1.exportSqlAndWait(client, baseId);
  if (!sql.ok) {
    ctx.log.warn('fork_base_db_export_failed_degrading', {
      base: baseId, error: sql.error.message,
    });
    return { source: 'skipped', reason: `export_failed: ${sql.error.message}` };
  }
  const etag = await sha256Hex(sql.value);
  const importR = await cfD1.importSqlAndWait(client, provisioned.d1.database_id, sql.value, etag);
  if (!importR.ok) {
    ctx.log.warn('fork_base_db_import_failed_degrading', {
      target: provisioned.d1.database_id, error: importR.error.message,
    });
    return { source: 'skipped', reason: `import_failed: ${importR.error.message}` };
  }
  ctx.log.info('fork_base_db_ok', {
    base: baseId,
    target: provisioned.d1.database_id,
    sql_bytes: sql.value.length,
  });
  return {
    source: 'forked',
    baseDatabaseId: baseId,
    sqlBytes: sql.value.length,
  };
};

/** Re-load the customer bundle if the prior await-bundle step said so. */
const maybeLoadCustomerBundle = async (
  ctx: StepContext,
): Promise<Awaited<ReturnType<typeof loadCustomerBundle>>> => {
  const awaited = ctx.prior['await-bundle'] as AwaitBundleResult | undefined;
  if (awaited?.source !== 'customer-bundle' || !awaited.bundleKey) return null;
  return loadCustomerBundle(ctx.env, awaited.bundleKey);
};

export const uploadScript = async (ctx: StepContext): Promise<UploadScriptResult> => {
  const { config, provisioned } = requirePrior(ctx);
  if (!cfWorkers.validateScriptName(ctx.scriptName)) {
    throw new NonRetryableError('E_VALIDATION', `invalid script name: ${ctx.scriptName}`);
  }
  const customerBundle = await maybeLoadCustomerBundle(ctx);
  const rewritten = buildRewrite(ctx, config, provisioned, customerBundle);
  // Resolve the actual main_module + compat date that went into the bundle.
  // For customer-bundle this is the customer's wrangler.json; for static /
  // fallback it falls back to the load-config defaults.
  const resolvedMainModule = customerBundle?.wrangler.main_module
    ?? customerBundle?.modules[0]?.name
    ?? config.wrangler.main_module;
  const resolvedCompatDate = customerBundle?.wrangler.compatibility_date ?? config.wrangler.compatibility_date;
  const resolvedCompatFlags = customerBundle?.wrangler.compatibility_flags ?? config.wrangler.compatibility_flags ?? [];
  const client = cfClientFromCtx(ctx);
  const params: Parameters<typeof cfWorkers.uploadScript>[1] = {
    scriptName: ctx.scriptName,
    mainModule: resolvedMainModule,
    modules: rewritten.modules,
    compatibilityDate: resolvedCompatDate,
    compatibilityFlags: resolvedCompatFlags,
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

interface LiveProbe { status: number; ms: number; bytes: number; ok: boolean }

/**
 * Fetch the bare workers.dev URL to confirm the preview is actually serving
 * traffic (not just that ROUTES KV got written). Cheap, gives reviewers an
 * at-a-glance "is this preview up right now?" signal.
 */
const probeLivePreview = async (ctx: StepContext): Promise<LiveProbe | null> => {
  // Skip the dispatcher 302 — talk straight to the user worker.
  const url = `https://${ctx.scriptName}.${ctx.env.CF_WORKERS_SUBDOMAIN}/`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual' });
    const buf = await r.arrayBuffer();
    return { status: r.status, ms: Date.now() - t0, bytes: buf.byteLength, ok: r.status >= 200 && r.status < 400 };
  } catch {
    return null;
  }
};

const buildPreviewCommentBody = (
  ctx: StepContext,
  config: LoadConfigResult,
  probe: LiveProbe | null,
): string => {
  const dashUrl = `https://raft-control.${ctx.env.CF_WORKERS_SUBDOMAIN}/dashboard/pr/${encodeURIComponent(ctx.prEnvId)}`;
  const awaited = ctx.prior['await-bundle'] as AwaitBundleResult | undefined;
  let bundleLine: string;
  if (config.mode === 'customer-bundle') {
    const sizeKb = awaited?.bundleBytes ? (awaited.bundleBytes / 1024).toFixed(1) : '?';
    bundleLine = `**Bundle:** customer Worker (uploaded via GitHub Action) · ${sizeKb} KB`;
  } else if (config.mode === 'static' && config.staticSynth) {
    bundleLine = `**Bundle:** static site · ${config.staticSynth.fileCount} file${config.staticSynth.fileCount === 1 ? '' : 's'} · ${(config.staticSynth.totalBytes / 1024).toFixed(1)} KB`;
  } else {
    // Fallback (no buildable source). Still complete the lifecycle but tell
    // the customer how to fix it. This shouldn't normally render in
    // production — both the customer-bundle and static-synth paths catch
    // every healthy repo.
    bundleLine = `**Configuration needed.** No \`wrangler.{jsonc,json,toml}\` (with the Raft GitHub Action) and no \`index.html\` found in this repo. Add one to deploy your real code on the next push.`;
  }
  const lines = [
    `### Raft preview`,
    ``,
    `**Preview:** ${ctx.previewHostname}/`,
    ``,
    bundleLine,
    `**Scope:** \`${ctx.scope}\` · **Worker:** \`${ctx.scriptName}\``,
  ];
  if (probe) {
    const status = probe.ok ? 'OK' : 'DOWN';
    lines.push(
      `**Probe:** ${status} · HTTP ${probe.status} · ${probe.ms} ms · ${(probe.bytes / 1024).toFixed(1)} KB`,
    );
  }
  lines.push(
    ``,
    `[Open in dashboard](${dashUrl})`,
    ``,
    `<sub>Per-PR isolated Cloudflare environment provisioned by [Raft](https://github.com/Adi-gitX/Rift). Torn down automatically when the PR closes.</sub>`,
  );
  return lines.join('\n');
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

    // Probe the live preview so the comment shows whether the new Worker
    // is actually serving traffic, not just whether the route was written.
    const probe = await probeLivePreview(ctx);
    if (probe) {
      ctx.log.info('preview_probe', { status: probe.status, ms: probe.ms, bytes: probe.bytes });
    }

    const body = buildPreviewCommentBody(ctx, config, probe);
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
  'await-bundle': awaitBundle,
  'provision-resources': provisionResources,
  'fork-base-db': forkBaseDb,
  'rewrite-bundle': rewriteBundleStep,
  'upload-script': uploadScript,
  'route-and-comment': routeAndComment,
} as const;

export interface StepResultMap {
  'load-config': LoadConfigResult;
  'await-bundle': AwaitBundleResult;
  'provision-resources': ProvisionResourcesResult;
  'fork-base-db': ForkBaseDbResult;
  'rewrite-bundle': RewriteBundleResult;
  'upload-script': UploadScriptResult;
  'route-and-comment': RouteAndCommentResult;
}

export const stepError = (e: unknown): CodedError | NonRetryableError =>
  e instanceof CodedError ? e : new CodedError('E_INTERNAL', String(e));
