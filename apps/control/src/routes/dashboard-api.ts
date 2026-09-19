/**
 * Dashboard-facing /api/* routes.
 *
 * Distinct from `/api/v1/*` (the original spec'd path). These shorter paths
 * are what the SPA client calls; they layer on top of the same db helpers.
 *
 * Auth: requires the same signed-cookie session as /api/v1/*.
 */
import { Hono } from 'hono';
import { apiErr, apiOk } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';
import { requireAuth } from '../middleware/require-auth.ts';
import { listActiveInstallations } from '../lib/db/installations.ts';
import { getRepo, listReposForInstallation } from '../lib/db/repos.ts';
import { getPrEnvironment, listPrEnvironmentsForRepo } from '../lib/db/prEnvironments.ts';
import { listAuditForInstallation, listAuditForTarget } from '../lib/db/auditLog.ts';
import type { LogTail, LogEvent } from '../do/log-tail.ts';
import type { ProvisionRunner } from '../do/provision-runner.ts';
import type { TeardownRunner } from '../do/teardown-runner.ts';
import { RAFT_VERSION } from '../version.ts';
import { computeStats } from '../lib/stats.ts';

export const dashboardApi = new Hono<ControlAppEnv>();

// All /api/* (except bundle upload, served by the v1 router) require auth.
dashboardApi.use('/api/*', async (c, next) => {
  if (c.req.path === '/api/v1/bundles/upload') return next();
  return requireAuth()(c, next);
});

dashboardApi.get('/api/me', async (c) => {
  const session = c.var.session;
  if (!session) {
    return c.json(apiErr('E_AUTH', 'no session', c.var.requestId), 401);
  }
  const installs = await listActiveInstallations(c.env.DB);
  return c.json(
    apiOk(
      {
        email: session.sub,
        exp: session.exp,
        installations: installs.ok ? installs.value : [],
        // Surface the GitHub App identity so the SPA can build the
        // "Install on a repo" deep-link without hard-coding the name.
        githubApp: {
          name: c.env.GITHUB_APP_NAME,
          installUrl: `https://github.com/apps/${c.env.GITHUB_APP_NAME}/installations/new`,
        },
        // CF account context lets the SPA build dash.cloudflare.com deep-links
        // (D1 / KV / Worker resource pages) without hard-coding the account id.
        cloudflare: {
          accountId: c.env.CF_OWN_ACCOUNT_ID,
          workersSubdomain: c.env.CF_WORKERS_SUBDOMAIN,
        },
      },
      c.var.requestId,
    ),
  );
});

/** List every repo across every active installation (single-operator demo). */
dashboardApi.get('/api/repos', async (c) => {
  const installs = await listActiveInstallations(c.env.DB);
  if (!installs.ok) {
    return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);
  }
  const all = [];
  for (const inst of installs.value) {
    const r = await listReposForInstallation(c.env.DB, inst.id);
    if (r.ok) all.push(...r.value);
  }
  return c.json(apiOk({ repos: all }, c.var.requestId));
});

dashboardApi.get('/api/repos/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const repo = await getRepo(c.env.DB, id);
  if (!repo.ok) return c.json(apiErr(repo.error.code, repo.error.message, c.var.requestId), 500);
  if (!repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  const prs = await listPrEnvironmentsForRepo(c.env.DB, id);
  return c.json(apiOk({ repo: repo.value, prs: prs.ok ? prs.value : [] }, c.var.requestId));
});

dashboardApi.get('/api/pr-environments', async (c) => {
  // No top-level "list all" repo helper — fan out across installations.
  const installs = await listActiveInstallations(c.env.DB);
  if (!installs.ok) {
    return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);
  }
  const all = [];
  for (const inst of installs.value) {
    const repos = await listReposForInstallation(c.env.DB, inst.id);
    if (!repos.ok) continue;
    for (const repo of repos.value) {
      const prs = await listPrEnvironmentsForRepo(c.env.DB, repo.id);
      if (prs.ok) all.push(...prs.value);
    }
  }
  return c.json(apiOk({ prs: all }, c.var.requestId));
});

dashboardApi.get('/api/pr-environments/:id', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const pe = await getPrEnvironment(c.env.DB, id);
  if (!pe.ok) return c.json(apiErr(pe.error.code, pe.error.message, c.var.requestId), 500);
  if (!pe.value) return c.json(apiErr('E_NOT_FOUND', 'pr env not found', c.var.requestId), 404);
  const audit = await listAuditForTarget(c.env.DB, 'pr_environment', id);
  return c.json(
    apiOk({ prEnvironment: pe.value, audit: audit.ok ? audit.value : [] }, c.var.requestId),
  );
});

dashboardApi.get('/api/pr-environments/:id/logs', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const stub = c.env.LOGTAIL.get(c.env.LOGTAIL.idFromName(id)) as DurableObjectStub<LogTail>;
  const r = await stub.fetch('https://internal/tail');
  const logs = (await r.json()) as LogEvent[];
  return c.json(apiOk({ logs }, c.var.requestId));
});

dashboardApi.get('/api/audit', async (c) => {
  // Last 50 entries across all active installations.
  const installs = await listActiveInstallations(c.env.DB);
  if (!installs.ok) {
    return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);
  }
  const all = [];
  for (const inst of installs.value) {
    const r = await listAuditForInstallation(c.env.DB, inst.id, 50);
    if (r.ok) all.push(...r.value);
  }
  all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return c.json(apiOk({ entries: all.slice(0, 50) }, c.var.requestId));
});

// ─── New deeper-data endpoints (Phase C) ─────────────────────────────────

dashboardApi.get('/api/stats', async (c) => {
  const installs = await listActiveInstallations(c.env.DB);
  if (!installs.ok) {
    return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);
  }
  const stats = await computeStats(c.env.DB, installs.value.length);
  return c.json(apiOk(stats, c.var.requestId));
});

dashboardApi.get('/api/health', async (c) => {
  const dispatcherUrl = `https://raft-dispatcher.${c.env.CF_WORKERS_SUBDOMAIN}/`;
  const tailUrl = `https://raft-tail.${c.env.CF_WORKERS_SUBDOMAIN}/`;
  const probe = async (
    url: string,
  ): Promise<{ status: 'ok' | 'unreachable'; httpStatus?: number }> => {
    try {
      const r = await fetch(url, { method: 'GET' });
      // raft-tail has no fetch() handler — it returns 500/404 for HTTP. That's still "deployed".
      return r.status >= 200 && r.status < 600
        ? { status: 'ok', httpStatus: r.status }
        : { status: 'unreachable', httpStatus: r.status };
    } catch {
      return { status: 'unreachable' };
    }
  };
  const [dispatcher, tail] = await Promise.all([probe(dispatcherUrl), probe(tailUrl)]);
  return c.json(
    apiOk(
      {
        control: { status: 'ok' as const, version: RAFT_VERSION },
        dispatcher: { ...dispatcher, url: dispatcherUrl },
        tail: { ...tail, url: tailUrl },
        cron: { schedule: '0 4 * * *' },
        env: c.env.RAFT_ENV,
      },
      c.var.requestId,
    ),
  );
});

dashboardApi.get('/api/pr-environments/:id/runner', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const stub = c.env.PROVISION_RUNNER.get(
    c.env.PROVISION_RUNNER.idFromName(id),
  ) as DurableObjectStub<ProvisionRunner>;
  try {
    const [snapshot, stepResults] = await Promise.all([
      stub.getStateSnapshot(),
      stub.getStepResults(),
    ]);
    return c.json(apiOk({ snapshot, stepResults }, c.var.requestId));
  } catch (e) {
    return c.json(apiErr('E_INTERNAL', `runner_state failed: ${String(e)}`, c.var.requestId), 500);
  }
});

dashboardApi.get('/api/pr-environments/:id/teardown-runner', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const stub = c.env.TEARDOWN_RUNNER.get(
    c.env.TEARDOWN_RUNNER.idFromName(id),
  ) as DurableObjectStub<TeardownRunner>;
  try {
    const [snapshot, stepResults] = await Promise.all([
      stub.getStateSnapshot(),
      stub.getStepResults(),
    ]);
    return c.json(apiOk({ snapshot, stepResults }, c.var.requestId));
  } catch (e) {
    return c.json(
      apiErr('E_INTERNAL', `teardown_runner_state failed: ${String(e)}`, c.var.requestId),
      500,
    );
  }
});

const repoCounts = (db: D1Database, repoId: string) =>
  db
    .prepare(
      `SELECT
       COUNT(*)                                             AS total_pr_envs,
       SUM(CASE WHEN state='ready'        THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN state='failed'       THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN state='torn_down'    THEN 1 ELSE 0 END) AS torn_down,
       SUM(CASE WHEN state IN ('pending','provisioning','updating','tearing_down') THEN 1 ELSE 0 END) AS in_flight
     FROM pr_environments WHERE repo_id = ?`,
    )
    .bind(repoId)
    .first<Record<string, number>>();

const repoRecentActivity = (db: D1Database, repoId: string) =>
  db
    .prepare(
      `SELECT id, action, created_at, target_id, actor
     FROM audit_log
     WHERE target_type = 'pr_environment' AND target_id LIKE ?
     ORDER BY created_at DESC LIMIT 25`,
    )
    .bind(`${repoId}:%`)
    .all<{ id: string; action: string; created_at: number; target_id: string; actor: string }>();

dashboardApi.get('/api/repos/:id/stats', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const repo = await getRepo(c.env.DB, id);
  if (!repo.ok) return c.json(apiErr(repo.error.code, repo.error.message, c.var.requestId), 500);
  if (!repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);
  const [counts, recent] = await Promise.all([
    repoCounts(c.env.DB, id),
    repoRecentActivity(c.env.DB, id),
  ]);
  return c.json(
    apiOk(
      {
        repo: repo.value,
        counts: {
          total_pr_envs: counts?.total_pr_envs ?? 0,
          ready: counts?.ready ?? 0,
          failed: counts?.failed ?? 0,
          torn_down: counts?.torn_down ?? 0,
          in_flight: counts?.in_flight ?? 0,
        },
        recent_activity: recent.results ?? [],
      },
      c.var.requestId,
    ),
  );
});
