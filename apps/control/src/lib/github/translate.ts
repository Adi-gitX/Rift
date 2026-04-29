/**
 * Translates a parsed GitHub webhook into one or more typed queue messages.
 * Centralized so the route handler stays a thin adapter.
 */
import type {
  InstallationPayload,
  InstallationReposPayload,
  PrPayload,
  RaftQueueMessage,
} from '../../env.ts';
import type {
  InstallationEvent,
  InstallationRepositoriesEvent,
  ParsedEvent,
  PullRequestEvent,
} from './schemas.ts';

const accountTypeMap = { User: 'user', Organization: 'organization' } as const;

const fromPullRequest = (e: PullRequestEvent, deliveryId: string): RaftQueueMessage => {
  const payload: PrPayload = {
    installationId: String(e.installation.id),
    repoFullName: e.repository.full_name,
    githubRepoId: e.repository.id,
    defaultBranch: e.repository.default_branch,
    prNumber: e.pull_request.number,
    headSha: e.pull_request.head.sha,
    headRef: e.pull_request.head.ref,
    baseSha: e.pull_request.base.sha,
    baseBranch: e.pull_request.base.ref,
    actorLogin: e.pull_request.user.login,
  };
  return { kind: `pr.${e.action}`, payload, deliveryId };
};

const fromInstallation = (e: InstallationEvent, deliveryId: string): RaftQueueMessage => {
  const payload: InstallationPayload = {
    installationId: String(e.installation.id),
    githubAccount: e.installation.account.login,
    githubAccountId: e.installation.account.id,
    accountType: accountTypeMap[e.installation.account.type],
  };
  return { kind: `installation.${e.action}`, payload, deliveryId };
};

const fromInstallationRepos = (
  e: InstallationRepositoriesEvent,
  deliveryId: string,
): RaftQueueMessage => {
  const payload: InstallationReposPayload = {
    installationId: String(e.installation.id),
    added: (e.repositories_added ?? []).map((r) => ({
      id: r.id,
      full_name: r.full_name,
      default_branch: r.default_branch,
    })),
    removed: (e.repositories_removed ?? []).map((r) => ({ id: r.id, full_name: r.full_name })),
  };
  return { kind: `installation_repositories.${e.action}`, payload, deliveryId };
};

export const translate = (parsed: ParsedEvent, deliveryId: string): RaftQueueMessage[] => {
  switch (parsed.kind) {
    case 'pull_request':
      return [fromPullRequest(parsed.event, deliveryId)];
    case 'installation':
      return [fromInstallation(parsed.event, deliveryId)];
    case 'installation_repositories':
      return [fromInstallationRepos(parsed.event, deliveryId)];
    case 'ignored':
      return [];
  }
};
