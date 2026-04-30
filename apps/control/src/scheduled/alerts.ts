/**
 * Operator alerting. Runs alongside the daily sweep:
 *   - Free-tier > 80% used (workers, D1, KV, queues)
 *   - Any PR env stuck in `provisioning` for > 5 minutes
 *
 * Alerts POST to `RAFT_ALERT_WEBHOOK` (Slack-incoming-webhook compatible
 * payload — works with Discord too via the Slack-format adapter URL).
 * No-op if the env var is unset.
 */
import type { Env } from '../env.ts';
import { Logger } from '../lib/logger.ts';

const STUCK_PROVISION_SECONDS = 5 * 60;

interface FreeTierSnapshot {
  workers: { used: number; cap: number };
  d1: { used: number; cap: number };
  kv: { used: number; cap: number };
  queues: { used: number; cap: number };
}

const readFreeTier = async (env: Env): Promise<FreeTierSnapshot> => {
  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(DISTINCT worker_script_name) FROM pr_environments WHERE worker_script_name IS NOT NULL AND state NOT IN ('torn_down','failed')) AS w,
       (SELECT COUNT(DISTINCT d1_database_id)     FROM pr_environments WHERE d1_database_id     IS NOT NULL AND state NOT IN ('torn_down','failed')) AS d,
       (SELECT COUNT(DISTINCT kv_namespace_id)    FROM pr_environments WHERE kv_namespace_id    IS NOT NULL AND state NOT IN ('torn_down','failed')) AS k,
       (SELECT COUNT(DISTINCT queue_id)           FROM pr_environments WHERE queue_id           IS NOT NULL AND state NOT IN ('torn_down','failed')) AS q`,
  ).first<{ w: number; d: number; k: number; q: number }>();
  const cp = { workers: 3, d1: 1, kv: 3, queues: 3 };
  return {
    workers: { used: (counts?.w ?? 0) + cp.workers, cap: 100 },
    d1:      { used: (counts?.d ?? 0) + cp.d1,      cap: 10 },
    kv:      { used: (counts?.k ?? 0) + cp.kv,      cap: 1000 },
    queues:  { used: (counts?.q ?? 0) + cp.queues,  cap: 10 },
  };
};

const findStuckProvisioning = async (
  env: Env,
  cutoffSeconds: number,
): Promise<Array<{ id: string; pr_number: number; last_activity_at: number | null }>> => {
  const r = await env.DB.prepare(
    `SELECT id, pr_number, last_activity_at
       FROM pr_environments
      WHERE state IN ('provisioning','pending','updating')
        AND last_activity_at < ?`,
  ).bind(cutoffSeconds).all<{ id: string; pr_number: number; last_activity_at: number | null }>();
  return r.results ?? [];
};

const postWebhook = async (
  env: Env,
  text: string,
  context: Record<string, unknown>,
  log: Logger,
): Promise<void> => {
  const url = env.RAFT_ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, context, env: env.RAFT_ENV }),
    });
    log.info('alert_posted', { context });
  } catch (e) {
    log.warn('alert_post_failed', { error: String(e) });
  }
};

export const runAlertChecks = async (env: Env): Promise<void> => {
  const log = new Logger({ component: 'cron.alerts' });

  // 1) Free-tier capacity. Only fire when one of the binding caps (D1 or
  //    Queues — they cap at 10 so they're the realistic risk) exceeds 80%.
  const ft = await readFreeTier(env);
  const slots: Array<[string, { used: number; cap: number }]> = [
    ['Workers', ft.workers], ['D1 dbs', ft.d1], ['KV namespaces', ft.kv], ['Queues', ft.queues],
  ];
  const hot = slots.filter(([, s]) => s.cap > 0 && s.used / s.cap >= 0.8);
  if (hot.length > 0) {
    const summary = hot.map(([name, s]) => `${name} ${s.used}/${s.cap} (${Math.round((s.used / s.cap) * 100)}%)`).join(' · ');
    await postWebhook(
      env,
      `:warning: Raft free-tier near cap — ${summary}`,
      { hot: Object.fromEntries(hot) },
      log,
    );
  }

  // 2) Stuck provisioning. Anything in pending / provisioning / updating with
  //    last_activity_at older than 5 minutes is suspicious — runner may have
  //    given up or hit an unhandled exception.
  const cutoff = Math.floor(Date.now() / 1000) - STUCK_PROVISION_SECONDS;
  const stuck = await findStuckProvisioning(env, cutoff);
  if (stuck.length > 0) {
    await postWebhook(
      env,
      `:rotating_light: ${stuck.length} PR env(s) stuck > 5min in pre-ready state`,
      { stuck: stuck.map((s) => ({ id: s.id, pr: s.pr_number, last_activity_at: s.last_activity_at })) },
      log,
    );
  }

  log.info('alert_checks_done', {
    free_tier_hot: hot.length,
    stuck_count: stuck.length,
    webhook_configured: !!env.RAFT_ALERT_WEBHOOK,
  });
};
