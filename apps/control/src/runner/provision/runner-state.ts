/**
 * Build the initial ProvisionRunnerState for a PR. Shared by the
 * RepoCoordinator (webhook path) and the manual redeploy API so the scope,
 * script name and preview URL never diverge between the two entry points.
 */
import type { PrPayload } from '../../env.ts';
import { buildScriptName } from '../../lib/cloudflare/workers.ts';
import type { ProvisionRunnerState } from './state.ts';

export const slugForScript = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 16);

/** `pr-<n>--<repoShort>` — globally unique across (repo, PR) for the dispatcher's `route:<scope>` lookup. */
export const scopeFor = (repoFullName: string, prNumber: number): string =>
  `pr-${prNumber}--${slugForScript(repoFullName)}`;

/** Free-tier substitution: previews are served via the dispatcher Worker at a path-based URL. */
export const previewHostnameFor = (workersSubdomain: string, scope: string): string =>
  `https://raft-dispatcher.${workersSubdomain}/${scope}`;

export const buildRunnerState = (
  payload: PrPayload,
  prEnvId: string,
  workersSubdomain: string,
): ProvisionRunnerState => {
  const scope = scopeFor(payload.repoFullName, payload.prNumber);
  return {
    prEnvId,
    installationId: payload.installationId,
    scope,
    scriptName: buildScriptName(
      slugForScript(payload.installationId),
      slugForScript(payload.repoFullName),
      payload.prNumber,
    ),
    previewHostname: previewHostnameFor(workersSubdomain, scope),
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
