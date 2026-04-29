/**
 * Zod schemas for the 6 GitHub webhook events Raft handles in v1
 * (PRD §8.1). Each event is parsed at the boundary; the narrowed types
 * are what the queue consumer / DOs see.
 */
import { z } from 'zod';

const installationRef = z.object({
  id: z.number().int(),
  account: z.object({
    login: z.string(),
    id: z.number().int(),
    type: z.enum(['User', 'Organization']),
  }),
});

const repository = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  default_branch: z.string().default('main'),
});

const pullRequest = z.object({
  number: z.number().int(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ sha: z.string(), ref: z.string() }),
  user: z.object({ login: z.string() }),
});

export const pullRequestEvent = z.object({
  action: z.enum(['opened', 'synchronize', 'reopened', 'closed']),
  number: z.number().int(),
  pull_request: pullRequest,
  repository,
  installation: z.object({ id: z.number().int() }),
});

export const installationEvent = z.object({
  action: z.enum(['created', 'deleted']),
  installation: installationRef,
});

export const installationRepositoriesEvent = z.object({
  action: z.enum(['added', 'removed']),
  installation: z.object({ id: z.number().int() }),
  repositories_added: z.array(repository).optional(),
  repositories_removed: z.array(repository).optional(),
});

export type PullRequestEvent = z.infer<typeof pullRequestEvent>;
export type InstallationEvent = z.infer<typeof installationEvent>;
export type InstallationRepositoriesEvent = z.infer<typeof installationRepositoriesEvent>;

export type ParsedEvent =
  | { kind: 'pull_request'; event: PullRequestEvent }
  | { kind: 'installation'; event: InstallationEvent }
  | { kind: 'installation_repositories'; event: InstallationRepositoriesEvent }
  | { kind: 'ignored'; reason: string };

export const parseEvent = (eventName: string, body: unknown): ParsedEvent => {
  switch (eventName) {
    case 'pull_request': {
      const r = pullRequestEvent.safeParse(body);
      return r.success
        ? { kind: 'pull_request', event: r.data }
        : { kind: 'ignored', reason: `pull_request parse failed: ${r.error.message}` };
    }
    case 'installation': {
      const r = installationEvent.safeParse(body);
      return r.success
        ? { kind: 'installation', event: r.data }
        : { kind: 'ignored', reason: `installation parse failed: ${r.error.message}` };
    }
    case 'installation_repositories': {
      const r = installationRepositoriesEvent.safeParse(body);
      return r.success
        ? { kind: 'installation_repositories', event: r.data }
        : { kind: 'ignored', reason: `installation_repositories parse failed: ${r.error.message}` };
    }
    default:
      return { kind: 'ignored', reason: `event ${eventName} not handled in v1` };
  }
};
