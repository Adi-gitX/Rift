/**
 * RepoCoordinator DO — one per (installation, repo). Receives the high-level
 * PR events, enforces the free-tier quota guard, writes the pr_environment
 * row, and starts the alarm-driven ProvisionRunner / TeardownRunner DOs.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env, PrPayload } from '../env.ts';
import { upsertInstallation } from '../lib/db/installations.ts';
import { upsertRepo, repoIdOf } from '../lib/db/repos.ts';
import { createPrEnvironment, prEnvIdOf } from '../lib/db/prEnvironments.ts';
import { appendAudit } from '../lib/db/auditLog.ts';
import { ulid } from '../lib/ids.ts';
import { Logger } from '../lib/logger.ts';
import type { PrEnvironment } from './pr-environment.ts';
import type { ProvisionRunner } from './provision-runner.ts';
import type { TeardownRunner } from './teardown-runner.ts';
import { buildRunnerState } from '../runner/provision/runner-state.ts';
import { mintUploadTokenHash } from '../lib/auth/upload-token.ts';

/** Control-plane D1 (raft-meta) + a customer base DB share the 10-DB free-tier cap. */
const D1_RESERVED = 2;
const QUEUES_RESERVED = 3;
const FREE_TIER_CAP = 10;

export class RepoCoordinator extends DurableObject<Env> {
  async onPrEvent(
    action: 'opened' | 'synchronize' | 'reopened' | 'closed',
    payload: PrPayload,
  ): Promise<void> {
    const log = new Logger({ installation_id: payload.installationId, repo: payload.repoFullName });
    log.info('pr_event', { action, pr: payload.prNumber });
    await this.ensureRepoRow(payload);
    if (action === 'closed') {
      await this.beginTeardown(payload);
      return;
    }
    await this.beginProvision(payload, action === 'synchronize' ? 'updating' : 'pending');
  }

  private async ensureRepoRow(payload: PrPayload): Promise<void> {
    const repoUpsert = await upsertRepo(this.env.DB, {
      installationId: payload.installationId,
      githubRepoId: payload.githubRepoId,
      fullName: payload.repoFullName,
      defaultBranch: payload.defaultBranch,
      // Fresh random hash on first insert; upsertRepo preserves the existing
      // hash on conflict. The operator obtains a usable plaintext token via
      // POST /api/v1/repos/:id/rotate-upload-token (never stored).
      uploadTokenHash: await mintUploadTokenHash(),
    });
    if (!repoUpsert.ok) throw repoUpsert.error;
  }

  /** Returns true when a fresh env would push D1 or Queues past the free-tier cap. */
  private async quotaBlocked(payload: PrPayload, repoId: string): Promise<boolean> {
    const live = await this.env.DB.prepare(
      `SELECT
         (SELECT COUNT(DISTINCT d1_database_id) FROM pr_environments WHERE d1_database_id IS NOT NULL AND state NOT IN ('torn_down','failed')) AS d1,
         (SELECT COUNT(DISTINCT queue_id)       FROM pr_environments WHERE queue_id       IS NOT NULL AND state NOT IN ('torn_down','failed')) AS q`,
    ).first<{ d1: number; q: number }>();
    const d1Free = FREE_TIER_CAP - D1_RESERVED - (live?.d1 ?? 0);
    const qFree = FREE_TIER_CAP - QUEUES_RESERVED - (live?.q ?? 0);
    if (d1Free > 0 && qFree > 0) return false;
    new Logger({ installation_id: payload.installationId, repo: payload.repoFullName }).warn(
      'quota_blocked',
      { d1_free: d1Free, q_free: qFree, pr: payload.prNumber },
    );
    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: payload.installationId,
      actor: 'quota-guard',
      action: 'pr_env.quota_blocked',
      targetType: 'pr_environment',
      targetId: prEnvIdOf(repoId, payload.prNumber),
      metadata: { d1_free: d1Free, q_free: qFree, head: payload.headSha },
    });
    return true;
  }

  private async beginProvision(
    payload: PrPayload,
    initialState: 'pending' | 'updating',
  ): Promise<void> {
    const repoId = repoIdOf(payload.installationId, payload.repoFullName);

    // Quota guard: block fresh `pending` envs near the free-tier cap; allow
    // `synchronize` on existing envs through (already counted).
    if (initialState === 'pending' && (await this.quotaBlocked(payload, repoId))) return;

    const prEnv = await createPrEnvironment(this.env.DB, {
      repoId,
      prNumber: payload.prNumber,
      headSha: payload.headSha,
    });
    if (!prEnv.ok) throw prEnv.error;

    await appendAudit(this.env.DB, {
      id: ulid(),
      installationId: payload.installationId,
      actor: 'github-webhook',
      action: 'pr_env.received',
      targetType: 'pr_environment',
      targetId: prEnv.value.id,
      metadata: { initial: initialState, head: payload.headSha },
    });

    const prStub = this.env.PR_ENV.get(
      this.env.PR_ENV.idFromName(prEnv.value.id),
    ) as DurableObjectStub<PrEnvironment>;
    await prStub.transitionTo(prEnv.value.id, 'provisioning', {
      installationId: payload.installationId,
      reason: initialState === 'updating' ? 'pr_synchronize' : 'pr_opened',
    });

    const runnerState = buildRunnerState(payload, prEnv.value.id, this.env.CF_WORKERS_SUBDOMAIN);
    const runner = this.env.PROVISION_RUNNER.get(
      this.env.PROVISION_RUNNER.idFromName(prEnv.value.id),
    ) as DurableObjectStub<ProvisionRunner>;
    await runner.start(runnerState);
  }

  private async beginTeardown(payload: PrPayload): Promise<void> {
    const repoId = repoIdOf(payload.installationId, payload.repoFullName);
    const prEnvId = prEnvIdOf(repoId, payload.prNumber);
    const teardown = this.env.TEARDOWN_RUNNER.get(
      this.env.TEARDOWN_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<TeardownRunner>;
    await teardown.start({
      prEnvId,
      installationId: payload.installationId,
      reason: 'pr_closed',
      cursor: 0,
      status: 'pending',
      attempts: 0,
      startedAt: 0,
      errorHistory: [],
    });
  }
}

export const repoCoordinatorIdName = (installationId: string, repoFullName: string): string =>
  `${installationId}:${repoFullName}`;

export const installationFromAccount = async (env: Env, payload: PrPayload): Promise<void> => {
  const r = await upsertInstallation(env.DB, {
    id: payload.installationId,
    githubAccount: payload.repoFullName.split('/')[0] ?? 'unknown',
    githubAccountId: 0,
    accountType: 'organization',
  });
  if (!r.ok) throw r.error;
};
