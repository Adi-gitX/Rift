/**
 * Operator-only admin endpoints (cookie session required).
 *
 *   POST /api/v1/admin/reconcile?dry_run=1|0&force=0|1
 *     Scan the Cloudflare account for per-PR resources whose PR env is
 *     torn_down/failed (orphans) and delete them. `dry_run=1` (default)
 *     only reports. `force=1` also deletes raft-*-pr-* resources that have
 *     no pr_environments row at all.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { apiErr, apiOk } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';
import { requireAuth } from '../middleware/require-auth.ts';
import { reconcileOrphans } from '../scheduled/reconcile.ts';
import {
  clearCloudflareConnection,
  getInstallation,
  publicInstallation,
  setCloudflareConnection,
  setInstallationConfig,
} from '../lib/db/installations.ts';
import { sealToken, verifyCloudflareToken } from '../lib/tenant.ts';
import { appendAudit } from '../lib/db/auditLog.ts';
import { ulid } from '../lib/ids.ts';

export const adminRoutes = new Hono<ControlAppEnv>();

adminRoutes.use('/api/v1/admin/*', requireAuth());

adminRoutes.post('/api/v1/admin/reconcile', async (c) => {
  const dryRun = c.req.query('dry_run') !== '0';
  const force = c.req.query('force') === '1';
  const result = await reconcileOrphans(c.env, {
    dryRun,
    force,
    actor: c.var.session?.sub ?? 'operator',
  });
  return c.json(apiOk(result, c.var.requestId));
});

// ── Per-installation Cloudflare accounts (multi-tenant) ──────────────────────
//
//   POST   /api/v1/installations/:id/cloudflare  { accountId, apiToken, workersSubdomain }
//   DELETE /api/v1/installations/:id/cloudflare
//
// The token is verified against the account (list Workers + D1), then stored
// AES-GCM-encrypted in D1. Runners for that installation provision into the
// tenant's own account from then on; the operator's shared token is only the
// fallback for installations that never connected.

const connectBody = z.object({
  accountId: z
    .string()
    .regex(/^[0-9a-f]{32}$/, 'accountId must be the 32-hex Cloudflare account id'),
  apiToken: z.string().min(20).max(200),
  workersSubdomain: z
    .string()
    .regex(/^[a-z0-9-]+\.workers\.dev$/, 'e.g. acme.workers.dev')
    .optional(),
});

adminRoutes.use('/api/v1/installations/:id/cloudflare', requireAuth());

adminRoutes.post('/api/v1/installations/:id/cloudflare', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const parsed = connectBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      apiErr('E_VALIDATION', parsed.error.issues[0]?.message ?? 'bad body', c.var.requestId),
      400,
    );
  }
  const inst = await getInstallation(c.env.DB, id);
  if (!inst.ok || !inst.value) {
    return c.json(apiErr('E_NOT_FOUND', 'installation not found', c.var.requestId), 404);
  }
  const verified = await verifyCloudflareToken(parsed.data.accountId, parsed.data.apiToken);
  if (!verified.ok) {
    return c.json(
      apiErr('E_VALIDATION', `token check failed: ${verified.reason}`, c.var.requestId),
      422,
    );
  }
  const sealed = await sealToken(c.env, parsed.data.apiToken);
  await setCloudflareConnection(c.env.DB, id, parsed.data.accountId, sealed);
  if (parsed.data.workersSubdomain) {
    await setInstallationConfig(c.env.DB, id, { workersSubdomain: parsed.data.workersSubdomain });
  }
  await appendAudit(c.env.DB, {
    id: ulid(),
    installationId: id,
    actor: c.var.session?.sub ?? 'operator',
    action: 'installation.cloudflare_connected',
    targetType: 'installation',
    targetId: id,
    metadata: { accountId: parsed.data.accountId, workersSubdomain: parsed.data.workersSubdomain },
  });
  const fresh = await getInstallation(c.env.DB, id);
  return c.json(
    apiOk(fresh.ok && fresh.value ? publicInstallation(fresh.value) : {}, c.var.requestId),
  );
});

adminRoutes.delete('/api/v1/installations/:id/cloudflare', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  await clearCloudflareConnection(c.env.DB, id);
  await appendAudit(c.env.DB, {
    id: ulid(),
    installationId: id,
    actor: c.var.session?.sub ?? 'operator',
    action: 'installation.cloudflare_disconnected',
    targetType: 'installation',
    targetId: id,
    metadata: {},
  });
  return c.json(apiOk({ disconnected: true }, c.var.requestId));
});
