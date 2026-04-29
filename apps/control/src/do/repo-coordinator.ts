/**
 * RepoCoordinator DO — one per (installation, repo). Receives the high-level
 * PR events and orchestrates the per-PR PrEnvironment DO transitions and
 * (eventually, in Slice D) the ProvisionRunner / TeardownRunner DO startup.
 *
 * Slice B scope: writes the pr_environment row, walks state to `ready`
 * synchronously as a stub. Slice D replaces the synchronous stub with the
 * alarm-driven ProvisionRunner DO.
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
import type { ProvisionRunnerState } from '../runner/provision/state.ts';
import { buildScriptName } from '../lib/cloudflare/workers.ts';

const PLACEHOLDER_TOKEN_HASH = 'pending-rotation';

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
      uploadTokenHash: PLACEHOLDER_TOKEN_HASH,
    });
    if (!repoUpsert.ok) throw repoUpsert.error;
  }

  private async beginProvision(
    payload: PrPayload,
    initialState: 'pending' | 'updating',
  ): Promise<void> {
    const repoId = repoIdOf(payload.installationId, payload.repoFullName);
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

    const prStub = this.env.PR_ENV.get(this.env.PR_ENV.idFromName(prEnv.value.id)) as DurableObjectStub<PrEnvironment>;
    await prStub.transitionTo(prEnv.value.id, 'provisioning', {
      installationId: payload.installationId,
      reason: initialState === 'updating' ? 'pr_synchronize' : 'pr_opened',
    });

    const runnerState = buildRunnerState(payload, prEnv.value.id);
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

const slugForScript = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);

const buildRunnerState = (payload: PrPayload, prEnvId: string): ProvisionRunnerState => {
  const installShort = slugForScript(payload.installationId);
  const repoShort = slugForScript(payload.repoFullName);
  // scope must be globally unique across (repo, PR) so the dispatcher's
  // path-prefix lookup (`route:<scope>`) doesn't collide. Encode both.
  const scope = `pr-${payload.prNumber}--${repoShort}`;
  return {
    prEnvId,
    installationId: payload.installationId,
    scope,
    scriptName: buildScriptName(installShort, repoShort, payload.prNumber),
    // Free-tier substitution: previews are served via the dispatcher Worker
    // at a path-based URL rather than a wildcard custom subdomain.
    previewHostname: `https://raft-dispatcher.adityakammati3.workers.dev/${scope}`,
    params: {
      installationId: payload.installationId,
      repoFullName: payload.repoFullName,
      prNumber: payload.prNumber,
      headSha: payload.headSha,
      baseSha: payload.baseSha,
      baseBranch: payload.baseBranch,
      triggerActor: payload.actorLogin,
    },
    cursor: 0,
    status: 'pending',
    attempts: 0,
    startedAt: 0,
    errorHistory: [],
  };
};

export const installationFromAccount = async (
  env: Env,
  payload: PrPayload,
): Promise<void> => {
  const r = await upsertInstallation(env.DB, {
    id: payload.installationId,
    githubAccount: payload.repoFullName.split('/')[0] ?? 'unknown',
    githubAccountId: 0,
    accountType: 'organization',
  });
  if (!r.ok) throw r.error;
};
