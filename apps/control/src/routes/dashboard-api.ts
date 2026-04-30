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
import {
  getRepo,
  listReposForInstallation,
} from '../lib/db/repos.ts';
import {
  getPrEnvironment,
  listPrEnvironmentsForRepo,
} from '../lib/db/prEnvironments.ts';
import { listAuditForInstallation, listAuditForTarget } from '../lib/db/auditLog.ts';
import type { LogTail, LogEvent } from '../do/log-tail.ts';
import type { ProvisionRunner } from '../do/provision-runner.ts';
import type { TeardownRunner } from '../do/teardown-runner.ts';

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
  return c.json(
    apiOk({ repo: repo.value, prs: prs.ok ? prs.value : [] }, c.var.requestId),
  );
});

dashboardApi.get('/api/pr-environments', async (c) => {
  // No top-level "list all" repo helper — fan out across installations.
  const installs = await listActiveInstallations(c.env.DB);
  if (!installs.ok) return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);
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
    apiOk(
      { prEnvironment: pe.value, audit: audit.ok ? audit.value : [] },
      c.var.requestId,
    ),
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
  if (!installs.ok) return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);
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
  if (!installs.ok) return c.json(apiErr(installs.error.code, installs.error.message, c.var.requestId), 500);

  // Direct SQL — much cheaper than fanning out via the repo layer.
  const counts = await c.env.DB.prepare(
    `SELECT
      (SELECT COUNT(*) FROM repos)                                AS repos,
      (SELECT COUNT(*) FROM pr_environments)                      AS pr_total,
      (SELECT COUNT(*) FROM pr_environments WHERE state='ready')        AS pr_ready,
      (SELECT COUNT(*) FROM pr_environments WHERE state='pending')      AS pr_pending,
      (SELECT COUNT(*) FROM pr_environments WHERE state='provisioning') AS pr_provisioning,
      (SELECT COUNT(*) FROM pr_environments WHERE state='updating')     AS pr_updating,
      (SELECT COUNT(*) FROM pr_environments WHERE state='failed')       AS pr_failed,
      (SELECT COUNT(*) FROM pr_environments WHERE state='tearing_down') AS pr_tearing_down,
      (SELECT COUNT(*) FROM pr_environments WHERE state='torn_down')    AS pr_torn_down,
      -- Count only resources backing currently-live PR envs. Anything in
      -- 'torn_down' or 'failed' has already been deleted from Cloudflare,
      -- so it doesn't consume free-tier capacity. Without this filter the
      -- gauge climbs every time a PR is opened-then-closed and never goes
      -- down — falsely reporting "free tier full".
      (SELECT COUNT(DISTINCT d1_database_id)     FROM pr_environments WHERE d1_database_id     IS NOT NULL AND state NOT IN ('torn_down','failed')) AS d1_used,
      (SELECT COUNT(DISTINCT kv_namespace_id)    FROM pr_environments WHERE kv_namespace_id    IS NOT NULL AND state NOT IN ('torn_down','failed')) AS kv_used,
      (SELECT COUNT(DISTINCT queue_id)           FROM pr_environments WHERE queue_id           IS NOT NULL AND state NOT IN ('torn_down','failed')) AS queue_used,
      (SELECT COUNT(DISTINCT worker_script_name) FROM pr_environments WHERE worker_script_name IS NOT NULL AND state NOT IN ('torn_down','failed')) AS worker_used,
      (SELECT COUNT(*) FROM audit_log WHERE action='provision.succeeded') AS provisions_succeeded,
      (SELECT COUNT(*) FROM audit_log WHERE action='provision.failed')    AS provisions_failed,
      (SELECT COUNT(*) FROM audit_log WHERE action='teardown.succeeded')  AS teardowns_succeeded,
      (SELECT COUNT(*) FROM audit_log WHERE action='teardown.failed')     AS teardowns_failed`,
  ).first<Record<string, number>>();

  // Last-7-day daily provision/teardown counts (UTC day buckets).
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const daily = await c.env.DB.prepare(
    `SELECT
       strftime('%Y-%m-%d', created_at, 'unixepoch') AS day,
       SUM(CASE WHEN action='provision.succeeded' THEN 1 ELSE 0 END) AS provisions,
       SUM(CASE WHEN action='provision.failed'    THEN 1 ELSE 0 END) AS provisions_failed,
       SUM(CASE WHEN action='teardown.succeeded'  THEN 1 ELSE 0 END) AS teardowns
     FROM audit_log
     WHERE created_at >= ?
     GROUP BY day
     ORDER BY day ASC`,
  ).bind(sevenDaysAgo).all<{ day: string; provisions: number; provisions_failed: number; teardowns: number }>();

  // Pad to a contiguous 7-day window so the sparkline never collapses to a
  // single tick. Backend builds the window so every consumer agrees on UTC
  // bucketing.
  const dailyByDay = new Map<string, { provisions: number; provisions_failed: number; teardowns: number }>();
  for (const row of daily.results ?? []) {
    dailyByDay.set(row.day, {
      provisions: row.provisions,
      provisions_failed: row.provisions_failed,
      teardowns: row.teardowns,
    });
  }
  const paddedDaily: Array<{ day: string; provisions: number; provisions_failed: number; teardowns: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const ts = Math.floor(Date.now() / 1000) - i * 86400;
    const day = new Date(ts * 1000).toISOString().slice(0, 10);
    const existing = dailyByDay.get(day);
    paddedDaily.push({
      day,
      provisions: existing?.provisions ?? 0,
      provisions_failed: existing?.provisions_failed ?? 0,
      teardowns: existing?.teardowns ?? 0,
    });
  }

  return c.json(
    apiOk(
      {
        installations: { active: installs.value.length },
        repos: counts?.repos ?? 0,
        prEnvironments: {
          total: counts?.pr_total ?? 0,
          by_state: {
            ready:         counts?.pr_ready         ?? 0,
            pending:       counts?.pr_pending       ?? 0,
            provisioning:  counts?.pr_provisioning  ?? 0,
            updating:      counts?.pr_updating      ?? 0,
            failed:        counts?.pr_failed        ?? 0,
            tearing_down:  counts?.pr_tearing_down  ?? 0,
            torn_down:     counts?.pr_torn_down     ?? 0,
          },
        },
        totals: {
          provisions_succeeded: counts?.provisions_succeeded ?? 0,
          provisions_failed:    counts?.provisions_failed    ?? 0,
          teardowns_succeeded:  counts?.teardowns_succeeded  ?? 0,
          teardowns_failed:     counts?.teardowns_failed     ?? 0,
        },
        freeTier: (() => {
          // PR-env resources currently consuming free-tier capacity.
          const prWorkers = counts?.worker_used ?? 0;
          const prD1      = counts?.d1_used     ?? 0;
          const prKv      = counts?.kv_used     ?? 0;
          const prQueues  = counts?.queue_used  ?? 0;
          // Fixed control-plane overhead — these resources are deployed by
          // wrangler.jsonc, not tracked in pr_environments, but still count
          // against the same free-tier caps. Hard-coded because they're
          // declared in wrangler.jsonc and don't change at runtime.
          const overhead = {
            workers: 3,        // raft-control, raft-dispatcher, raft-tail
            d1: 1,             // raft-meta
            kv: 3,             // CACHE, ROUTES, BUNDLES_KV
            queues: 3,         // raft-events, raft-events-dlq, raft-tail-events
          };
          // CF free-tier caps: Workers 100 scripts, D1 10 dbs, Queues 10.
          return {
            workers:       { used: prWorkers + overhead.workers, max: 100,  pr_envs: prWorkers, control_plane: overhead.workers },
            d1_databases:  { used: prD1      + overhead.d1,      max: 10,   pr_envs: prD1,      control_plane: overhead.d1 },
            kv_namespaces: { used: prKv      + overhead.kv,      max: 1000, pr_envs: prKv,      control_plane: overhead.kv },
            queues:        { used: prQueues  + overhead.queues,  max: 10,   pr_envs: prQueues,  control_plane: overhead.queues },
          };
        })(),
        daily: paddedDaily,
      },
      c.var.requestId,
    ),
  );
});

dashboardApi.get('/api/health', async (c) => {
  const dispatcherUrl = `https://raft-dispatcher.${c.env.CF_WORKERS_SUBDOMAIN}/`;
  const tailUrl = `https://raft-tail.${c.env.CF_WORKERS_SUBDOMAIN}/`;
  const probe = async (url: string): Promise<{ status: 'ok' | 'unreachable'; httpStatus?: number }> => {
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
        control: { status: 'ok' as const, version: '0.1.0' },
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
  const stub = c.env.PROVISION_RUNNER.get(c.env.PROVISION_RUNNER.idFromName(id)) as DurableObjectStub<ProvisionRunner>;
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
  const stub = c.env.TEARDOWN_RUNNER.get(c.env.TEARDOWN_RUNNER.idFromName(id)) as DurableObjectStub<TeardownRunner>;
  try {
    const [snapshot, stepResults] = await Promise.all([
      stub.getStateSnapshot(),
      stub.getStepResults(),
    ]);
    return c.json(apiOk({ snapshot, stepResults }, c.var.requestId));
  } catch (e) {
    return c.json(apiErr('E_INTERNAL', `teardown_runner_state failed: ${String(e)}`, c.var.requestId), 500);
  }
});

dashboardApi.get('/api/repos/:id/stats', async (c) => {
  const id = decodeURIComponent(c.req.param('id'));
  const repo = await getRepo(c.env.DB, id);
  if (!repo.ok) return c.json(apiErr(repo.error.code, repo.error.message, c.var.requestId), 500);
  if (!repo.value) return c.json(apiErr('E_NOT_FOUND', 'repo not found', c.var.requestId), 404);

  const counts = await c.env.DB.prepare(
    `SELECT
       COUNT(*)                                             AS total_pr_envs,
       SUM(CASE WHEN state='ready'        THEN 1 ELSE 0 END) AS ready,
       SUM(CASE WHEN state='failed'       THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN state='torn_down'    THEN 1 ELSE 0 END) AS torn_down,
       SUM(CASE WHEN state IN ('pending','provisioning','updating','tearing_down') THEN 1 ELSE 0 END) AS in_flight
     FROM pr_environments WHERE repo_id = ?`,
  ).bind(id).first<Record<string, number>>();

  const recent = await c.env.DB.prepare(
    `SELECT id, action, created_at, target_id, actor
     FROM audit_log
     WHERE target_type = 'pr_environment' AND target_id LIKE ?
     ORDER BY created_at DESC LIMIT 25`,
  ).bind(`${id}:%`).all<{ id: string; action: string; created_at: number; target_id: string; actor: string }>();

  return c.json(
    apiOk(
      {
        repo: repo.value,
        counts: {
          total_pr_envs: counts?.total_pr_envs ?? 0,
          ready:         counts?.ready         ?? 0,
          failed:        counts?.failed        ?? 0,
          torn_down:     counts?.torn_down     ?? 0,
          in_flight:     counts?.in_flight     ?? 0,
        },
        recent_activity: recent.results ?? [],
      },
      c.var.requestId,
    ),
  );
});
