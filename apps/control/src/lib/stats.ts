/**
 * Dashboard overview stats: PR-env counts by state, lifetime totals,
 * free-tier headroom, and a padded 7-day daily series. Direct SQL — much
 * cheaper than fanning out via the repo layer.
 */

/** Control-plane resources declared in wrangler.jsonc that count against the same caps. */
export const CONTROL_PLANE_OVERHEAD = {
  workers: 3, // raft-control, raft-dispatcher, raft-tail
  d1: 1, // raft-meta
  kv: 3, // CACHE, ROUTES, BUNDLES_KV
  queues: 3, // raft-events, raft-events-dlq, raft-tail-events
} as const;

/** CF free-tier caps: Workers 100 scripts, D1 10 dbs, KV 1000 namespaces, Queues 10. */
export const FREE_TIER_CAPS = { workers: 100, d1: 10, kv: 1000, queues: 10 } as const;

interface CountRow extends Record<string, number> {
  repos: number;
  pr_total: number;
  pr_ready: number;
  pr_pending: number;
  pr_provisioning: number;
  pr_updating: number;
  pr_failed: number;
  pr_tearing_down: number;
  pr_torn_down: number;
  d1_used: number;
  kv_used: number;
  queue_used: number;
  worker_used: number;
  provisions_succeeded: number;
  provisions_failed: number;
  teardowns_succeeded: number;
  teardowns_failed: number;
}

export interface DailyPoint {
  day: string;
  provisions: number;
  provisions_failed: number;
  teardowns: number;
}

const LIVE = `state NOT IN ('torn_down','failed')`;

const readCounts = (db: D1Database): Promise<CountRow | null> =>
  db
    .prepare(
      `SELECT
      (SELECT COUNT(*) FROM repos)                                            AS repos,
      (SELECT COUNT(*) FROM pr_environments)                                  AS pr_total,
      (SELECT COUNT(*) FROM pr_environments WHERE state='ready')              AS pr_ready,
      (SELECT COUNT(*) FROM pr_environments WHERE state='pending')            AS pr_pending,
      (SELECT COUNT(*) FROM pr_environments WHERE state='provisioning')       AS pr_provisioning,
      (SELECT COUNT(*) FROM pr_environments WHERE state='updating')           AS pr_updating,
      (SELECT COUNT(*) FROM pr_environments WHERE state='failed')             AS pr_failed,
      (SELECT COUNT(*) FROM pr_environments WHERE state='tearing_down')       AS pr_tearing_down,
      (SELECT COUNT(*) FROM pr_environments WHERE state='torn_down')          AS pr_torn_down,
      (SELECT COUNT(DISTINCT d1_database_id)     FROM pr_environments WHERE d1_database_id     IS NOT NULL AND ${LIVE}) AS d1_used,
      (SELECT COUNT(DISTINCT kv_namespace_id)    FROM pr_environments WHERE kv_namespace_id    IS NOT NULL AND ${LIVE}) AS kv_used,
      (SELECT COUNT(DISTINCT queue_id)           FROM pr_environments WHERE queue_id           IS NOT NULL AND ${LIVE}) AS queue_used,
      (SELECT COUNT(DISTINCT worker_script_name) FROM pr_environments WHERE worker_script_name IS NOT NULL AND ${LIVE}) AS worker_used,
      (SELECT COUNT(*) FROM audit_log WHERE action='provision.succeeded') AS provisions_succeeded,
      (SELECT COUNT(*) FROM audit_log WHERE action='provision.failed')    AS provisions_failed,
      (SELECT COUNT(*) FROM audit_log WHERE action='teardown.succeeded')  AS teardowns_succeeded,
      (SELECT COUNT(*) FROM audit_log WHERE action='teardown.failed')     AS teardowns_failed`,
    )
    .first<CountRow>();

/** Last-7-day daily provision/teardown counts, padded to a contiguous UTC window. */
export const readDailySeries = async (db: D1Database, now = Date.now()): Promise<DailyPoint[]> => {
  const nowSec = Math.floor(now / 1000);
  const rows = await db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at, 'unixepoch') AS day,
              SUM(CASE WHEN action='provision.succeeded' THEN 1 ELSE 0 END) AS provisions,
              SUM(CASE WHEN action='provision.failed'    THEN 1 ELSE 0 END) AS provisions_failed,
              SUM(CASE WHEN action='teardown.succeeded'  THEN 1 ELSE 0 END) AS teardowns
         FROM audit_log WHERE created_at >= ? GROUP BY day ORDER BY day ASC`,
    )
    .bind(nowSec - 7 * 86400)
    .all<DailyPoint>();
  const byDay = new Map((rows.results ?? []).map((r) => [r.day, r]));
  const out: DailyPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date((nowSec - i * 86400) * 1000).toISOString().slice(0, 10);
    const hit = byDay.get(day);
    out.push({
      day,
      provisions: hit?.provisions ?? 0,
      provisions_failed: hit?.provisions_failed ?? 0,
      teardowns: hit?.teardowns ?? 0,
    });
  }
  return out;
};

const slot = (used: number, overhead: number, max: number) => ({
  used: used + overhead,
  max,
  pr_envs: used,
  control_plane: overhead,
});

export const computeStats = async (db: D1Database, activeInstallations: number) => {
  const [c, daily] = await Promise.all([readCounts(db), readDailySeries(db)]);
  const n = (k: keyof CountRow): number => c?.[k] ?? 0;
  return {
    installations: { active: activeInstallations },
    repos: n('repos'),
    prEnvironments: {
      total: n('pr_total'),
      by_state: {
        ready: n('pr_ready'),
        pending: n('pr_pending'),
        provisioning: n('pr_provisioning'),
        updating: n('pr_updating'),
        failed: n('pr_failed'),
        tearing_down: n('pr_tearing_down'),
        torn_down: n('pr_torn_down'),
      },
    },
    totals: {
      provisions_succeeded: n('provisions_succeeded'),
      provisions_failed: n('provisions_failed'),
      teardowns_succeeded: n('teardowns_succeeded'),
      teardowns_failed: n('teardowns_failed'),
    },
    // Only resources backing live PR envs consume free-tier capacity.
    freeTier: {
      workers: slot(n('worker_used'), CONTROL_PLANE_OVERHEAD.workers, FREE_TIER_CAPS.workers),
      d1_databases: slot(n('d1_used'), CONTROL_PLANE_OVERHEAD.d1, FREE_TIER_CAPS.d1),
      kv_namespaces: slot(n('kv_used'), CONTROL_PLANE_OVERHEAD.kv, FREE_TIER_CAPS.kv),
      queues: slot(n('queue_used'), CONTROL_PLANE_OVERHEAD.queues, FREE_TIER_CAPS.queues),
    },
    daily,
  };
};
