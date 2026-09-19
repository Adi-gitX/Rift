/**
 * Step 1 — load-config.
 *
 * Detects how this PR's Worker will be produced (customer-bundle / static /
 * fallback) and, new in v0.3, what the customer's D1 setup looks like so
 * later steps can fork the base DB and preview the PR's migrations.
 */
import { getInstallationToken } from '../../../lib/github/app.ts';
import {
  base64ToBytes,
  getRepoBlob,
  getRepoTree,
  type RepoTree,
} from '../../../lib/github/contents.ts';
import { repoIdOf, setBaseResources } from '../../../lib/db/repos.ts';
import {
  detectStatic,
  fetchAndInlineFiles,
  synthesizeWorker,
} from '../../../lib/static-site/synth.ts';
import { findWranglerEntry, parseWranglerD1 } from '../../../lib/d1-migrations/wrangler-config.ts';
import { listMigrationFiles } from '../../../lib/d1-migrations/plan.ts';
import type { WranglerD1Config } from '../../../lib/d1-migrations/types.ts';
import { FALLBACK_WRANGLER, signScopeForSynth, type StepContext } from './context.ts';
import type {
  DbConfigSummary,
  LoadConfigMode,
  LoadConfigResult,
  StaticSynthSummary,
} from './types.ts';

interface CachedConfig {
  mode: LoadConfigMode;
  staticBundleSource?: string;
  staticSynth?: StaticSynthSummary;
  db?: DbConfigSummary;
}

const cacheKeyFor = (ctx: StepContext): string =>
  `bundle-cache:${ctx.params.repoFullName}@${ctx.params.headSha}`;

const baseResult = (ctx: StepContext, mode: LoadConfigMode): LoadConfigResult => ({
  wrangler: { ...FALLBACK_WRANGLER, main_module: 'worker.js' },
  bundleR2Key: `bundles/${ctx.scriptName}.zip`,
  mode,
});

const fromCache = (ctx: StepContext, cached: CachedConfig): LoadConfigResult => {
  const r = baseResult(
    ctx,
    cached.mode === 'static' && !cached.staticBundleSource ? 'fallback' : cached.mode,
  );
  if (r.mode === 'static' && cached.staticBundleSource) {
    r.staticBundleSource = cached.staticBundleSource;
  }
  if (r.mode === 'static' && cached.staticSynth) r.staticSynth = cached.staticSynth;
  if (cached.db) r.db = cached.db;
  return r;
};

const putCache = (ctx: StepContext, value: CachedConfig): Promise<void> =>
  ctx.env.CACHE.put(cacheKeyFor(ctx), JSON.stringify(value), { expirationTtl: 86400 });

const ghToken = (ctx: StepContext): Promise<string> =>
  getInstallationToken(
    ctx.env.CACHE,
    { appId: ctx.env.GITHUB_APP_ID, privateKeyPem: ctx.env.GITHUB_APP_PRIVATE_KEY },
    ctx.params.installationId,
  );

const toDbSummary = (
  parsed: WranglerD1Config,
  wranglerPath: string,
  tree: RepoTree,
): DbConfigSummary => {
  const summary: DbConfigSummary = {
    baseDatabaseId: parsed.databaseId,
    migrationsDir: parsed.migrationsDir,
    wranglerPath,
    migrationFiles: listMigrationFiles(tree, parsed.migrationsDir),
  };
  if (parsed.databaseName) summary.baseDatabaseName = parsed.databaseName;
  if (parsed.binding) summary.binding = parsed.binding;
  return summary;
};

/**
 * Read the customer's wrangler config at headSha and extract the base D1
 * (+ migrations dir + list of migration files). Persists `base_d1_id` on
 * the repo row so the dashboard can show it. Never throws — DB preview is
 * best-effort; the Worker preview must not depend on it.
 */
export const detectDbConfig = async (
  ctx: StepContext,
  token: string,
  tree: RepoTree,
): Promise<DbConfigSummary | undefined> => {
  const entry = findWranglerEntry(tree);
  if (!entry) return undefined;
  try {
    const blob = await getRepoBlob(token, ctx.params.repoFullName, entry.sha);
    const text = new TextDecoder().decode(base64ToBytes(blob.content));
    const parsed = parseWranglerD1(text, entry.path);
    if (!parsed) {
      ctx.log.info('load_config_no_d1_in_wrangler', { path: entry.path });
      return undefined;
    }
    const summary = toDbSummary(parsed, entry.path, tree);
    await setBaseResources(
      ctx.env.DB,
      repoIdOf(ctx.params.installationId, ctx.params.repoFullName),
      {
        baseD1Id: parsed.databaseId,
        raftConfig: {
          migrationsDir: parsed.migrationsDir,
          wranglerPath: entry.path,
          detectedAt: Date.now(),
        },
      },
    );
    ctx.log.info('load_config_db_detected', {
      base_d1: parsed.databaseId,
      migrations: summary.migrationFiles.length,
    });
    return summary;
  } catch (e) {
    ctx.log.warn('load_config_db_detect_failed', { error: String(e) });
    return undefined;
  }
};

const staticSynthConfig = async (
  ctx: StepContext,
  token: string,
  tree: RepoTree,
): Promise<LoadConfigResult | null> => {
  const detection = detectStatic(tree);
  if (!detection.isStatic) {
    ctx.log.info('load_config_no_static_match', { tree_truncated: tree.truncated });
    return null;
  }
  const synth = await fetchAndInlineFiles(token, ctx.params.repoFullName, detection);
  if (synth.files.length === 0) {
    ctx.log.warn('load_config_static_zero_files', { warnings: synth.warnings });
    return null;
  }
  const expectedToken = await signScopeForSynth(ctx.scope, ctx.env.INTERNAL_DISPATCH_SECRET);
  const result = baseResult(ctx, 'static');
  result.staticBundleSource = synthesizeWorker(synth, { expectedToken });
  result.staticSynth = {
    fileCount: synth.files.length,
    totalBytes: synth.totalBytes,
    warnings: synth.warnings,
  };
  ctx.log.info('load_config_static_synth_ok', {
    files: synth.files.length,
    bytes: synth.totalBytes,
  });
  return result;
};

const hasWranglerConfig = (tree: RepoTree): boolean =>
  tree.tree.some((e) => e.type === 'blob' && /^wrangler\.(jsonc|json|toml)$/.test(e.path));

export const loadConfig = async (ctx: StepContext): Promise<LoadConfigResult> => {
  ctx.log.info('load_config_start', { pr: ctx.params.prNumber, repo: ctx.params.repoFullName });
  // Smart-redeploy short-circuit: same headSha ⇒ byte-identical bundle.
  const cached = (await ctx.env.CACHE.get(cacheKeyFor(ctx), 'json')) as CachedConfig | null;
  if (cached) {
    ctx.log.info('load_config_cache_hit', { headSha: ctx.params.headSha, mode: cached.mode });
    return fromCache(ctx, cached);
  }
  // GitHub failures (bad App key, repo deleted, outage) degrade to the
  // placeholder bundle so the PR never gets stuck; the next push retries.
  let token: string;
  let tree: RepoTree;
  try {
    token = await ghToken(ctx);
    tree = await getRepoTree(token, ctx.params.repoFullName, ctx.params.headSha);
  } catch (e) {
    ctx.log.warn('load_config_github_failed_degrading', { error: String(e) });
    return baseResult(ctx, 'fallback');
  }
  const db = await detectDbConfig(ctx, token, tree);
  let result: LoadConfigResult;
  if (hasWranglerConfig(tree)) {
    ctx.log.info('load_config_customer_bundle_detected');
    result = baseResult(ctx, 'customer-bundle');
  } else {
    result = (await staticSynthConfig(ctx, token, tree)) ?? baseResult(ctx, 'fallback');
  }
  if (db) result.db = db;
  if (result.mode !== 'fallback') {
    const toCache: CachedConfig = { mode: result.mode };
    if (result.staticBundleSource) toCache.staticBundleSource = result.staticBundleSource;
    if (result.staticSynth) toCache.staticSynth = result.staticSynth;
    if (db) toCache.db = db;
    await putCache(ctx, toCache);
  }
  return result;
};
