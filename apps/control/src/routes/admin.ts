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
import { apiOk } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';
import { requireAuth } from '../middleware/require-auth.ts';
import { reconcileOrphans } from '../scheduled/reconcile.ts';

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
