/**
 * Step 2 — await-bundle (Track A: customer-Worker bundle ingestion).
 *
 * Waits for the customer's GH Action to POST the built bundle to
 * /api/v1/bundles/upload. Static / fallback modes return immediately.
 */
import { CodedError, NonRetryableError } from '@raft/shared-types';
import { bundleKvKey } from '../../../lib/bundle-key.ts';
import type { StepContext } from './context.ts';
import type { AwaitBundleResult, LoadConfigResult } from './types.ts';

const AWAIT_BUNDLE_TIMEOUT_MS = 5 * 60 * 1000;
const AWAIT_BUNDLE_POLL_MS = 2000;
/** Max wall-clock spent inside ONE alarm invocation. Keeping alarms short lets a
 *  synchronize (new head SHA) restart the runner instead of waiting behind a
 *  5-minute blocking loop. The runner re-arms on `await_bundle_pending`. */
const AWAIT_BUNDLE_SLICE_MS = 20 * 1000;
export const AWAIT_BUNDLE_PENDING = 'await_bundle_pending';

export const awaitBundle = async (ctx: StepContext): Promise<AwaitBundleResult> => {
  const config = ctx.prior['load-config'] as LoadConfigResult | undefined;
  const sliceStart = Date.now();
  const waitStart = ctx.stepStartedAt ?? sliceStart;
  if (!config || config.mode !== 'customer-bundle') {
    return { source: config?.mode === 'static' ? 'static-synth' : 'placeholder', waitedMs: 0 };
  }
  const key = bundleKvKey(ctx.params.installationId, ctx.params.repoFullName, ctx.params.headSha);
  while (Date.now() - sliceStart < AWAIT_BUNDLE_SLICE_MS) {
    const meta = await ctx.env.BUNDLES_KV.getWithMetadata<{ etag?: string; bytes?: number }>(key);
    if (meta.value) {
      return {
        source: 'customer-bundle',
        bundleKey: key,
        bundleBytes: meta.metadata?.bytes ?? meta.value.length,
        ...(meta.metadata?.etag ? { bundleEtag: meta.metadata.etag } : {}),
        waitedMs: Date.now() - waitStart,
      };
    }
    await new Promise((r) => setTimeout(r, AWAIT_BUNDLE_POLL_MS));
  }
  if (Date.now() - waitStart < AWAIT_BUNDLE_TIMEOUT_MS) {
    // Not an error: the runner re-arms shortly without counting an attempt.
    throw new CodedError('E_CONFLICT', AWAIT_BUNDLE_PENDING);
  }
  throw new NonRetryableError(
    'E_VALIDATION',
    `bundle upload timed out after ${AWAIT_BUNDLE_TIMEOUT_MS}ms — did the GH Action run? POST to /api/v1/bundles/upload`,
  );
};
