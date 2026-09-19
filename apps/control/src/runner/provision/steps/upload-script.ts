/**
 * Step 8 — upload-script: PUT /workers/scripts/{name} with the rewritten
 * bundle, then enable the *.workers.dev subdomain.
 *
 * Handles CF's "binding resource not propagated yet" 400s (codes 10181 /
 * 10041 / 100100) with a short in-step retry — D1/KV/Queue typically take
 * 2-5s to become bindable after creation.
 */
import { type CodedError, NonRetryableError } from '@raft/shared-types';
import * as cfWorkers from '../../../lib/cloudflare/workers.ts';
import { setResourceHandles } from '../../../lib/db/prEnvironments.ts';
import { cfClientFromCtx, requirePrior, type StepContext } from './context.ts';
import { buildRewrite, maybeLoadCustomerBundle, resolveCompat } from './bundle.ts';
import type { UploadScriptResult } from './types.ts';

const PROPAGATION_ERROR_CODES = ['10181', '10041', '100100'] as const;
const UPLOAD_PROPAGATION_RETRIES = 5;
const UPLOAD_PROPAGATION_DELAY_MS = 2000;

const isPropagationLag = (e: CodedError): boolean => {
  const body = (e.details as { body?: string } | undefined)?.body ?? '';
  return PROPAGATION_ERROR_CODES.some((code) => body.includes(`"code":${code}`));
};

const buildUploadParams = async (
  ctx: StepContext,
): Promise<Parameters<typeof cfWorkers.uploadScript>[1]> => {
  const { config, provisioned } = requirePrior(ctx);
  const customer = await maybeLoadCustomerBundle(ctx);
  const rewritten = buildRewrite(ctx, config, provisioned, customer);
  const compat = resolveCompat(config, customer);
  return {
    scriptName: ctx.scriptName,
    mainModule: compat.mainModule,
    modules: rewritten.modules,
    compatibilityDate: compat.compatibilityDate,
    compatibilityFlags: compat.compatibilityFlags,
    bindings: rewritten.bindings as cfWorkers.WorkerBinding[],
    // Free-tier substitution: tail_consumers requires Workers Paid (CF error
    // code 100150), so v1 omits it. Re-enable when raft-tail can be bound.
    tags: [
      `installation:${ctx.params.installationId}`,
      `repo:${ctx.params.repoFullName}`,
      `pr:${ctx.params.prNumber}`,
    ],
  };
};

export const uploadScript = async (ctx: StepContext): Promise<UploadScriptResult> => {
  if (!cfWorkers.validateScriptName(ctx.scriptName)) {
    throw new NonRetryableError('E_VALIDATION', `invalid script name: ${ctx.scriptName}`);
  }
  const params = await buildUploadParams(ctx);
  const client = cfClientFromCtx(ctx);
  for (let attempt = 0; attempt < UPLOAD_PROPAGATION_RETRIES; attempt++) {
    const r = await cfWorkers.uploadScript(client, params);
    if (r.ok) {
      await setResourceHandles(ctx.env.DB, ctx.prEnvId, { workerScriptName: ctx.scriptName });
      // *.workers.dev exposure is disabled by default for REST-uploaded
      // scripts. Failure here is logged but non-fatal.
      const sub = await cfWorkers.enableSubdomain(client, ctx.scriptName);
      if (!sub.ok) ctx.log.warn('enable_subdomain_failed', { error: sub.error.message });
      return r.value.etag === undefined
        ? { scriptId: r.value.id }
        : { scriptId: r.value.id, etag: r.value.etag };
    }
    if (!isPropagationLag(r.error) || attempt === UPLOAD_PROPAGATION_RETRIES - 1) throw r.error;
    const delay = ctx.propagationDelayMs ?? UPLOAD_PROPAGATION_DELAY_MS;
    ctx.log.warn('upload_script_propagation_retry', { attempt: attempt + 1, delay_ms: delay });
    await new Promise((res) => setTimeout(res, delay));
  }
  throw new NonRetryableError('E_CF_API', 'upload_script: propagation_exhausted');
};
