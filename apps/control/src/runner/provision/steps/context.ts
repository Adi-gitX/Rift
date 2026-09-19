/**
 * Shared context + helpers for ProvisionRunner steps.
 *
 * Each step takes a `StepContext`, returns a JSON-serializable result that
 * the runner persists to DO storage under `step:<name>`. Throwing means
 * "retryable" (the runner will back off + retry); throwing
 * `NonRetryableError` short-circuits to failure + compensating teardown.
 */
import { NonRetryableError } from '@raft/shared-types';
import type { Env, ProvisionPRParams } from '../../../env.ts';
import { CFClient } from '../../../lib/cloudflare/client.ts';
import type { CustomerWranglerSummary } from '../../../lib/bundle-rewriter/types.ts';
import { type Logger } from '../../../lib/logger.ts';
import type { LoadConfigResult, ProvisionResourcesResult } from './types.ts';

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
  /** When the current step first started (survives retries). Used by await-bundle's deadline. */
  stepStartedAt?: number;
}

export const FALLBACK_WRANGLER: CustomerWranglerSummary = {
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
 * problem (see comment-body.ts).
 */
export const PLACEHOLDER_BUNDLE_SOURCE = `export default {
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

export const cfClientFromCtx = (ctx: StepContext): CFClient =>
  new CFClient({
    accountId: ctx.env.CF_OWN_ACCOUNT_ID,
    token: ctx.env.CF_API_TOKEN,
    fetcher: ctx.fetcher,
    logger: ctx.log,
    baseDelayMs: 50,
  });

export const requirePrior = (
  ctx: StepContext,
): { config: LoadConfigResult; provisioned: ProvisionResourcesResult } => {
  const config = ctx.prior['load-config'] as LoadConfigResult | undefined;
  const provisioned = ctx.prior['provision-resources'] as ProvisionResourcesResult | undefined;
  if (!config || !provisioned) throw new NonRetryableError('E_INTERNAL', 'prior steps missing');
  return { config, provisioned };
};

/**
 * Compute the same per-scope HMAC token raft-dispatcher emits, so the
 * synthesized worker can verify requests came through the dispatcher.
 * Keep this function byte-for-byte aligned with apps/dispatcher/src/index.ts:signScope.
 */
export const signScopeForSynth = async (scope: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`raft-preview:${scope}`)),
  );
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(sig[i] ?? 0);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const sha256Hex = async (s: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};
