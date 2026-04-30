/**
 * /api/v1/* — internal JSON API for the dashboard SPA + the customer's
 * GitHub-Action bundle upload.
 *
 * Auth model:
 *   - Most endpoints require the signed `raft_session` cookie (Slice G's
 *     free-tier substitute for Cloudflare Access).
 *   - `POST /api/v1/bundles/upload` is exempt from cookie auth and uses
 *     a per-repo upload token (PRD amendment A6) instead.
 *
 * Rate limit: every authenticated route runs through a per-installation
 * sliding-window check (100 req/min). Bundle upload uses its own per-repo
 * limit (30/min) keyed by repo id.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { apiErr, apiOk } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';
import { requireAuth } from '../middleware/require-auth.ts';
import { checkRateLimit } from '../lib/auth/rate-limit.ts';
import {
  hashUploadToken,
  isUploadTokenShape,
  mintUploadToken,
  verifyUploadToken,
} from '../lib/auth/upload-token.ts';
import {
  listActiveInstallations,
  getInstallation,
} from '../lib/db/installations.ts';
import { getRepo, listReposForInstallation, rotateUploadTokenHash } from '../lib/db/repos.ts';
import { getPrEnvironment, listPrEnvironmentsForRepo } from '../lib/db/prEnvironments.ts';
import { listAuditForInstallation } from '../lib/db/auditLog.ts';
import type { ProvisionRunner } from '../do/provision-runner.ts';
import type { TeardownRunner } from '../do/teardown-runner.ts';
import type { ProvisionRunnerState } from '../runner/provision/state.ts';
import { buildScriptName } from '../lib/cloudflare/workers.ts';
import { ulid } from '../lib/ids.ts';

const RATE_LIMIT_PER_MIN = 100;
const RATE_WINDOW_S = 60;

const repoIdParam = z.object({ repoId: z.string().min(1) });
const installIdParam = z.object({ id: z.string().min(1) });
const prIdParam = z.object({ prEnvId: z.string().min(1) });

export const apiRoutes = new Hono<ControlAppEnv>();

apiRoutes.use('/api/v1/*', async (c, next) => {
  // Bundle upload + GitHub webhook are NOT cookie-protected.
  if (c.req.path === '/api/v1/bundles/upload') return next();
  return requireAuth()(c, next);
});

apiRoutes.use('/api/v1/*', async (c, next) => {
  if (c.req.path === '/api/v1/bundles/upload') return next();
  const session = c.var.session;
  if (!session) return next();
  const verdict = await checkRateLimit(c.env.CACHE, `op:${session.sub}`, RATE_LIMIT_PER_MIN, RATE_WINDOW_S);
  c.header('x-ratelimit-remaining', String(verdict.remaining));
  if (!verdict.allowed) {
    return c.json(apiErr('E_RATE_LIMIT', `rate limit ${RATE_LIMIT_PER_MIN}/min exceeded`, c.var.requestId), 429);
  }
  return next();
});

apiRoutes.get('/api/v1/installations', async (c) => {
  const r = await listActiveInstallations(c.env.DB);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  return c.json(apiOk({ installations: r.value }, c.var.requestId));
});

apiRoutes.get('/api/v1/installations/:id', async (c) => {
  const { id } = installIdParam.parse(c.req.param());
  const r = await getInstallation(c.env.DB, id);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  if (!r.value) return c.json(apiErr('E_NOT_FOUND', 'installation not found', c.var.requestId), 404);
  return c.json(apiOk(r.value, c.var.requestId));
});

apiRoutes.get('/api/v1/installations/:id/repos', async (c) => {
  const { id } = installIdParam.parse(c.req.param());
  const r = await listReposForInstallation(c.env.DB, id);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  return c.json(apiOk({ repos: r.value }, c.var.requestId));
});

apiRoutes.get('/api/v1/repos/:repoId', async (c) => {
  const { repoId } = repoIdParam.parse(c.req.param());
  const r = await getRepo(c.env.DB, repoId);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  if (!r.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  return c.json(apiOk(r.value, c.var.requestId));
});

apiRoutes.get('/api/v1/repos/:repoId/prs', async (c) => {
  const { repoId } = repoIdParam.parse(c.req.param());
  const r = await listPrEnvironmentsForRepo(c.env.DB, repoId);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  return c.json(apiOk({ prs: r.value }, c.var.requestId));
});

apiRoutes.get('/api/v1/prs/:prEnvId', async (c) => {
  const { prEnvId } = prIdParam.parse(c.req.param());
  const r = await getPrEnvironment(c.env.DB, prEnvId);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  if (!r.value) return c.json(apiErr('E_NOT_FOUND', 'pr env not found', c.var.requestId), 404);
  return c.json(apiOk(r.value, c.var.requestId));
});

apiRoutes.get('/api/v1/audit/:installationId', async (c) => {
  const r = await listAuditForInstallation(c.env.DB, c.req.param('installationId'));
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  return c.json(apiOk({ entries: r.value }, c.var.requestId));
});

apiRoutes.post('/api/v1/prs/:prEnvId/teardown', async (c) => {
  const { prEnvId } = prIdParam.parse(c.req.param());
  const pe = await getPrEnvironment(c.env.DB, prEnvId);
  if (!pe.ok || !pe.value) return c.json(apiErr('E_NOT_FOUND', 'pr env not found', c.var.requestId), 404);
  const repo = await getRepo(c.env.DB, pe.value.repoId);
  if (!repo.ok || !repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  const stub = c.env.TEARDOWN_RUNNER.get(
    c.env.TEARDOWN_RUNNER.idFromName(prEnvId),
  ) as DurableObjectStub<TeardownRunner>;
  await stub.start({
    prEnvId,
    installationId: repo.value.installationId,
    reason: 'manual',
    cursor: 0,
    status: 'pending',
    attempts: 0,
    startedAt: 0,
    errorHistory: [],
  });
  return c.json(apiOk({ accepted: true, prEnvId }, c.var.requestId), 202);
});

apiRoutes.post('/api/v1/prs/:prEnvId/redeploy', async (c) => {
  const { prEnvId } = prIdParam.parse(c.req.param());
  const pe = await getPrEnvironment(c.env.DB, prEnvId);
  if (!pe.ok || !pe.value) return c.json(apiErr('E_NOT_FOUND', 'pr env not found', c.var.requestId), 404);
  const repo = await getRepo(c.env.DB, pe.value.repoId);
  if (!repo.ok || !repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  const installShort = repo.value.installationId.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
  const repoShort = repo.value.fullName.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
  const scope = `pr-${pe.value.prNumber}`;
  const initial: ProvisionRunnerState = {
    prEnvId,
    installationId: repo.value.installationId,
    scope,
    scriptName: buildScriptName(installShort, repoShort, pe.value.prNumber),
    previewHostname: `${scope}--${repoShort}.preview.raft`,
    params: {
      installationId: repo.value.installationId,
      repoFullName: repo.value.fullName,
      prNumber: pe.value.prNumber,
      headSha: pe.value.headSha,
      baseSha: '',
      baseBranch: repo.value.defaultBranch,
      triggerActor: c.var.session?.sub ?? 'manual',
    },
    cursor: 0,
    status: 'pending',
    attempts: 0,
    startedAt: 0,
    errorHistory: [],
  };
  const stub = c.env.PROVISION_RUNNER.get(
    c.env.PROVISION_RUNNER.idFromName(prEnvId),
  ) as DurableObjectStub<ProvisionRunner>;
  await stub.start(initial);
  return c.json(apiOk({ accepted: true, prEnvId }, c.var.requestId), 202);
});

apiRoutes.post('/api/v1/repos/:repoId/rotate-upload-token', async (c) => {
  const { repoId } = repoIdParam.parse(c.req.param());
  const repo = await getRepo(c.env.DB, repoId);
  if (!repo.ok || !repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  const token = mintUploadToken();
  const hash = await hashUploadToken(token);
  const r = await rotateUploadTokenHash(c.env.DB, repoId, hash);
  if (!r.ok) return c.json(apiErr(r.error.code, r.error.message, c.var.requestId), 500);
  // Returned ONCE — the dashboard must show it to the operator immediately.
  return c.json(apiOk({ upload_token: token, repo_id: repoId }, c.var.requestId));
});

// JSON bundle payload schema. The customer's GH Action posts this:
//   {
//     wrangler: {main_module, compatibility_date, compatibility_flags?, bindings?},
//     modules: [{name, content_b64, type?}, ...],
//   }
// Modules are base64-encoded so the payload is one self-contained JSON blob —
// no zip parser needed inside the worker.
const bundleUploadSchema = z.object({
  wrangler: z.object({
    main_module: z.string().optional(),
    compatibility_date: z.string().optional(),
    compatibility_flags: z.array(z.string()).optional(),
    bindings: z.array(z.object({}).passthrough()).optional(),
  }).passthrough().default({}),
  modules: z.array(z.object({
    name: z.string().min(1).max(256),
    content_b64: z.string().min(1),
    type: z.string().optional(),
  })).min(1).max(50),
});

apiRoutes.post('/api/v1/bundles/upload', async (c) => {
  const auth = c.req.header('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  const repoId = c.req.header('x-raft-repo-id') ?? '';
  const headSha = c.req.header('x-raft-head-sha') ?? '';
  if (!isUploadTokenShape(token) || !repoId || !headSha) {
    return c.json(apiErr('E_AUTH', 'missing/invalid headers', c.var.requestId), 401);
  }
  const repo = await getRepo(c.env.DB, repoId);
  if (!repo.ok || !repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  const ok = await verifyUploadToken(token, repo.value.uploadTokenHash);
  if (!ok) return c.json(apiErr('E_AUTH', 'invalid upload token', c.var.requestId), 401);
  const verdict = await checkRateLimit(c.env.CACHE, `up:${repoId}`, 30, 60);
  if (!verdict.allowed) {
    return c.json(apiErr('E_RATE_LIMIT', '30 uploads/min exceeded', c.var.requestId), 429);
  }

  // Parse + validate JSON payload.
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(apiErr('E_VALIDATION', 'invalid JSON', c.var.requestId), 400);
  }
  const parsed = bundleUploadSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json(apiErr('E_VALIDATION', `bad payload: ${parsed.error.message}`, c.var.requestId), 400);
  }

  // Repack with timestamps so the runner / dashboard can show ingestion ts.
  const payload = {
    ...parsed.data,
    uploadedAt: Math.floor(Date.now() / 1000),
    bytes: parsed.data.modules.reduce((s, m) => s + m.content_b64.length, 0),
  };
  const json = JSON.stringify(payload);
  if (json.length > 24 * 1024 * 1024) {
    return c.json(apiErr('E_VALIDATION', 'bundle exceeds 24MB KV cap', c.var.requestId), 413);
  }

  const id = ulid();
  // KV key MUST mirror runner/provision/steps.ts `bundleKvKey()`.
  const key = `bundle:${repo.value.installationId}:${repo.value.fullName}:${headSha}`;
  await c.env.BUNDLES_KV.put(key, json, {
    metadata: { id, headSha, repoId, modules: parsed.data.modules.length, bytes: json.length },
    expirationTtl: 14 * 86400,
  });
  return c.json(apiOk({
    id,
    key,
    modules: parsed.data.modules.length,
    bytes: json.length,
  }, c.var.requestId));
});
