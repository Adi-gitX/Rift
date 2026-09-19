/**
 * Step 9 — route-and-comment: write the dispatcher route into ROUTES KV,
 * probe the live preview, and upsert the sticky PR comment.
 */
import { getInstallationToken } from '../../../lib/github/app.ts';
import { upsertStickyComment } from '../../../lib/github/comments.ts';
import { setResourceHandles } from '../../../lib/db/prEnvironments.ts';
import type { StepContext } from './context.ts';
import { buildPreviewCommentBody, type LiveProbe } from './comment-body.ts';
import type { LoadConfigResult, RouteAndCommentResult } from './types.ts';

/**
 * Fetch the bare workers.dev URL to confirm the preview is actually serving
 * traffic (not just that ROUTES KV got written).
 */
const probeLivePreview = async (ctx: StepContext): Promise<LiveProbe | null> => {
  const url = `https://${ctx.scriptName}.${ctx.env.CF_WORKERS_SUBDOMAIN}/`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { redirect: 'manual' });
    const buf = await r.arrayBuffer();
    return {
      status: r.status,
      ms: Date.now() - t0,
      bytes: buf.byteLength,
      ok: r.status >= 200 && r.status < 400,
    };
  } catch {
    return null;
  }
};

const postComment = async (
  ctx: StepContext,
  config: LoadConfigResult,
  result: RouteAndCommentResult,
): Promise<void> => {
  const token = await getInstallationToken(
    ctx.env.CACHE,
    { appId: ctx.env.GITHUB_APP_ID, privateKeyPem: ctx.env.GITHUB_APP_PRIVATE_KEY },
    ctx.params.installationId,
  );
  const probe = await probeLivePreview(ctx);
  if (probe) {
    ctx.log.info('preview_probe', { status: probe.status, ms: probe.ms, bytes: probe.bytes });
  }
  const upsert = await upsertStickyComment({
    token,
    ownerRepo: ctx.params.repoFullName,
    issueNumber: ctx.params.prNumber,
    body: buildPreviewCommentBody(ctx, config, probe),
    marker: 'preview',
  });
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, { prCommentId: upsert.commentId });
  result.prCommentId = upsert.commentId;
  result.prCommentCreated = upsert.created;
  ctx.log.info('pr_comment_upserted', { comment_id: upsert.commentId, created: upsert.created });
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
  // GitHub failures are non-fatal: the preview is already live; the next
  // pull_request.synchronize gets another shot at the comment.
  try {
    await postComment(ctx, config, result);
  } catch (e) {
    ctx.log.warn('pr_comment_skipped', { error: String(e) });
    result.prCommentSkippedReason = String(e);
  }
  return result;
};
