/**
 * Cron-driven garbage collector for stale PR environments (PRD §10).
 * Selects ready envs whose last activity was more than 7 days ago and fires
 * a TeardownRunner per env (capped at 100 per cron tick to bound the work).
 */
import type { Env } from '../env.ts';
import { listStalePrEnvironments } from '../lib/db/prEnvironments.ts';
import { Logger } from '../lib/logger.ts';
import type { TeardownRunner } from '../do/teardown-runner.ts';

const STALE_AFTER_SECONDS = 7 * 24 * 60 * 60;
const MAX_SWEEP_BATCH = 100;

const sweepEnv = async (env: Env, prEnvId: string, installationId: string): Promise<void> => {
  const stub = env.TEARDOWN_RUNNER.get(
    env.TEARDOWN_RUNNER.idFromName(prEnvId),
  ) as DurableObjectStub<TeardownRunner>;
  await stub.start({
    prEnvId,
    installationId,
    reason: 'idle_7d',
    cursor: 0,
    status: 'pending',
    attempts: 0,
    startedAt: 0,
    errorHistory: [],
  });
};

export const sweepStaleEnvironments = async (env: Env): Promise<void> => {
  const log = new Logger({ component: 'cron.sweep' });
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  const r = await listStalePrEnvironments(env.DB, cutoff, MAX_SWEEP_BATCH);
  if (!r.ok) {
    log.error('list_stale_failed', { err: String(r.error) });
    return;
  }
  log.info('sweep_start', { stale_count: r.value.length, cutoff });
  // Look up installation_id for each PR env (joined from repos).
  for (const prEnv of r.value) {
    const repoRow = await env.DB.prepare(`SELECT installation_id FROM repos WHERE id = ?`)
      .bind(prEnv.repoId)
      .first<{ installation_id: string }>();
    if (!repoRow) continue;
    try {
      await sweepEnv(env, prEnv.id, repoRow.installation_id);
      log.info('sweep_triggered', { pr_env_id: prEnv.id });
    } catch (e) {
      log.error('sweep_failed', { pr_env_id: prEnv.id, err: String(e) });
    }
  }
};
