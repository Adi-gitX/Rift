/**
 * Step 7 — rewrite-bundle, plus the shared "build the rewritten bundle"
 * helper that upload-script re-runs (the rewritten modules are not
 * persisted between steps; they're cheap to recompute and would bloat DO
 * storage).
 */
import { NonRetryableError } from '@raft/shared-types';
import type { Env } from '../../../env.ts';
import { rewriteBundle } from '../../../lib/bundle-rewriter/index.ts';
import type { BundleInputs, RewrittenBundle } from '../../../lib/bundle-rewriter/types.ts';
import { PLACEHOLDER_BUNDLE_SOURCE, requirePrior, type StepContext } from './context.ts';
import type {
  AwaitBundleResult,
  LoadConfigResult,
  ProvisionResourcesResult,
  RewriteBundleResult,
  UploadedBundlePayload,
} from './types.ts';

export interface CustomerBundle {
  wrangler: UploadedBundlePayload['wrangler'];
  modules: { name: string; content: Uint8Array; type: string }[];
}

const decodeB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/** Load the previously-stored customer bundle from KV, parse + decode it. */
export const loadCustomerBundle = async (env: Env, key: string): Promise<CustomerBundle | null> => {
  const text = await env.BUNDLES_KV.get(key);
  if (!text) return null;
  let payload: UploadedBundlePayload;
  try {
    payload = JSON.parse(text) as UploadedBundlePayload;
  } catch {
    return null;
  }
  return {
    wrangler: payload.wrangler ?? {},
    modules: payload.modules.map((m) => ({
      name: m.name,
      content: decodeB64(m.content_b64),
      type: m.type ?? 'application/javascript+module',
    })),
  };
};

/** Re-load the customer bundle if the prior await-bundle step said so. */
export const maybeLoadCustomerBundle = async (ctx: StepContext): Promise<CustomerBundle | null> => {
  const awaited = ctx.prior['await-bundle'] as AwaitBundleResult | undefined;
  if (awaited?.source !== 'customer-bundle' || !awaited.bundleKey) return null;
  return loadCustomerBundle(ctx.env, awaited.bundleKey);
};

/** The main_module + compat settings that actually go into the upload. */
export const resolveCompat = (
  config: LoadConfigResult,
  customer: CustomerBundle | null,
): { mainModule: string; compatibilityDate: string; compatibilityFlags: string[] } => ({
  mainModule:
    customer?.wrangler.main_module ?? customer?.modules[0]?.name ?? config.wrangler.main_module,
  compatibilityDate: customer?.wrangler.compatibility_date ?? config.wrangler.compatibility_date,
  compatibilityFlags:
    customer?.wrangler.compatibility_flags ?? config.wrangler.compatibility_flags ?? [],
});

/** The customer's wrangler summary, with compat fields resolved from the uploaded bundle. */
const customerWrangler = (
  config: LoadConfigResult,
  customer: CustomerBundle,
): LoadConfigResult['wrangler'] => {
  const compat = resolveCompat(config, customer);
  return {
    main_module: compat.mainModule,
    compatibility_date: compat.compatibilityDate,
    ...(customer.wrangler.compatibility_flags
      ? { compatibility_flags: customer.wrangler.compatibility_flags }
      : {}),
    bindings: (customer.wrangler.bindings ??
      config.wrangler.bindings) as typeof config.wrangler.bindings,
    do_classes_to_shard: config.wrangler.do_classes_to_shard,
  };
};

export const buildRewrite = (
  ctx: StepContext,
  config: LoadConfigResult,
  provisioned: ProvisionResourcesResult,
  customer: CustomerBundle | null,
): RewrittenBundle => {
  let modules: BundleInputs['modules'];
  let wrangler = config.wrangler;
  if (config.mode === 'customer-bundle' && customer && customer.modules.length > 0) {
    // Customer-uploaded modules. Use the customer's wrangler config so DO
    // class names + extra bindings are honoured by the rewriter.
    modules = customer.modules.map((m) => ({
      name: m.name,
      content: m.content,
      contentType: m.type,
    }));
    wrangler = customerWrangler(config, customer);
  } else {
    const source =
      config.mode === 'static' && config.staticBundleSource
        ? config.staticBundleSource
        : PLACEHOLDER_BUNDLE_SOURCE;
    modules = [
      { name: wrangler.main_module, content: source, contentType: 'application/javascript+module' },
    ];
  }
  return rewriteBundle({
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
  });
};

export const rewriteBundleStep = async (ctx: StepContext): Promise<RewriteBundleResult> => {
  const { config, provisioned } = requirePrior(ctx);
  const awaited = ctx.prior['await-bundle'] as AwaitBundleResult | undefined;
  const customer = await maybeLoadCustomerBundle(ctx);
  if (awaited?.source === 'customer-bundle' && !customer) {
    throw new NonRetryableError(
      'E_INTERNAL',
      `customer bundle disappeared from KV: ${awaited.bundleKey}`,
    );
  }
  const rewritten = buildRewrite(ctx, config, provisioned, customer);
  const compat = resolveCompat(config, customer);
  ctx.log.info('rewrite_bundle', {
    source: awaited?.source ?? 'unknown',
    main_module: compat.mainModule,
    modules_count: rewritten.modules.length,
    warnings: rewritten.warnings,
  });
  const result: RewriteBundleResult = {
    bindings: rewritten.bindings,
    modulesCount: rewritten.modules.length,
    warnings: rewritten.warnings,
    mainModule: compat.mainModule,
    compatibilityDate: compat.compatibilityDate,
  };
  if (customer?.wrangler.compatibility_flags) {
    result.compatibilityFlags = customer.wrangler.compatibility_flags;
  }
  return result;
};
