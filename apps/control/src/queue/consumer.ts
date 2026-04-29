/**
 * Queue consumer — dispatches RaftQueueMessage batch into per-repo DOs and
 * direct D1 writes for installation lifecycle events.
 *
 * Errors per message are isolated; a single bad message doesn't ack the rest.
 * Successful handling acks the message; thrown errors trigger queue retry
 * (max_retries=5, then DLQ — see wrangler.jsonc).
 */
import type { Env, PrPayload, RaftQueueMessage } from '../env.ts';
import { upsertInstallation, softDeleteInstallation } from '../lib/db/installations.ts';
import { upsertRepo } from '../lib/db/repos.ts';
import { Logger } from '../lib/logger.ts';
import { repoCoordinatorIdName } from '../do/repo-coordinator.ts';
import type { RepoCoordinator } from '../do/repo-coordinator.ts';

const PLACEHOLDER_HASH = 'pending-rotation';

const dispatchPr = async (env: Env, payload: PrPayload, action: 'opened' | 'synchronize' | 'reopened' | 'closed'): Promise<void> => {
  await upsertInstallation(env.DB, {
    id: payload.installationId,
    githubAccount: payload.repoFullName.split('/')[0] ?? 'unknown',
    githubAccountId: 0,
    accountType: 'organization',
  });
  const id = env.REPO.idFromName(repoCoordinatorIdName(payload.installationId, payload.repoFullName));
  const stub = env.REPO.get(id) as DurableObjectStub<RepoCoordinator>;
  await stub.onPrEvent(action, payload);
};

const handleOne = async (env: Env, msg: RaftQueueMessage): Promise<void> => {
  switch (msg.kind) {
    case 'pr.opened':
    case 'pr.synchronize':
    case 'pr.reopened':
    case 'pr.closed':
      await dispatchPr(env, msg.payload, msg.kind.slice('pr.'.length) as 'opened' | 'synchronize' | 'reopened' | 'closed');
      return;
    case 'installation.created':
      await upsertInstallation(env.DB, {
        id: msg.payload.installationId,
        githubAccount: msg.payload.githubAccount,
        githubAccountId: msg.payload.githubAccountId,
        accountType: msg.payload.accountType,
      });
      return;
    case 'installation.deleted':
      await softDeleteInstallation(env.DB, msg.payload.installationId);
      return;
    case 'installation_repositories.added':
      for (const r of msg.payload.added) {
        await upsertRepo(env.DB, {
          installationId: msg.payload.installationId,
          githubRepoId: r.id,
          fullName: r.full_name,
          defaultBranch: r.default_branch,
          uploadTokenHash: PLACEHOLDER_HASH,
        });
      }
      return;
    case 'installation_repositories.removed':
      // Soft-handled: repo rows orphan-cascade via installation soft-delete.
      // Explicit removal isn't strictly necessary v1 — flagged for Slice G.
      // TODO(raft:slice-G) — surface installation_repositories.removed in audit_log.
      return;
  }
};

export const handleQueueBatch = async (
  batch: MessageBatch<RaftQueueMessage>,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> => {
  const log = new Logger({ env: env.RAFT_ENV });
  for (const msg of batch.messages) {
    try {
      await handleOne(env, msg.body);
      msg.ack();
    } catch (e) {
      log.error('queue_message_failed', {
        kind: msg.body.kind,
        delivery: msg.body.deliveryId,
        err: String(e),
      });
      msg.retry();
    }
  }
};
