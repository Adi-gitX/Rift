/**
 * Typed Env interface for the raft-control Worker.
 * Mirrors PRD §14 in full. Bindings are added to wrangler.jsonc incrementally
 * as each task in PRD §18 lands; reading a binding before its task has shipped
 * will yield `undefined` at runtime — code that references a binding must
 * therefore live behind the task that wires it.
 *
 * Per PRD §13: every binding declared in wrangler.jsonc MUST appear here.
 * Per PRD §20: no `process.env`. All config flows through this interface.
 */
import type { RepoCoordinator, PrEnvironment, LogTail, ProvisionRunner, TeardownRunner } from './index.ts';

export type RaftEnvName = 'production' | 'staging' | 'dev';

export interface Env {
  // ── Vars (PRD §13) ────────────────────────────────────────────────────────
  readonly RAFT_BASE_DOMAIN: string;
  readonly RAFT_ENV: RaftEnvName;
  readonly GITHUB_APP_ID: string;
  readonly GITHUB_APP_CLIENT_ID: string;
  readonly GITHUB_APP_NAME: string;
  /** Optional. When present, every static-synth preview gets a Claude-written
   *  summary appended to the sticky PR comment. Skip silently if absent. */
  readonly ANTHROPIC_API_KEY?: string;
  readonly CF_OWN_ACCOUNT_ID: string;
  /** workers.dev subdomain prefix used to route PR previews on the free tier. */
  readonly CF_WORKERS_SUBDOMAIN: string;
  readonly ACCESS_TEAM_DOMAIN: string;
  readonly ACCESS_AUD: string;

  // ── D1 ────────────────────────────────────────────────────────────────────
  readonly DB: D1Database;

  // ── KV ────────────────────────────────────────────────────────────────────
  // Free-tier substitution: PRD §4 used R2 for bundle/template/log storage.
  // For the free-tier demo we replace the bundle bucket with `BUNDLES_KV`
  // (bundle blobs base64'd into KV values; small bundles only — capped at
  // ~25MB per value, which fits a wrangler-deploy --dry-run output).
  readonly CACHE: KVNamespace;
  readonly ROUTES: KVNamespace;
  readonly BUNDLES_KV: KVNamespace;

  // ── Queues ────────────────────────────────────────────────────────────────
  readonly EVENTS: Queue<RaftQueueMessage>;
  readonly TAIL_EVENTS: Queue<TailEvent>;

  // ── Durable Objects ───────────────────────────────────────────────────────
  // PROVISION_RUNNER / TEARDOWN_RUNNER replace Cloudflare Workflows under the
  // free-tier substitution: alarm-driven step machines, idempotency keyed by
  // step name in DO storage.
  readonly REPO: DurableObjectNamespace<RepoCoordinator>;
  readonly PR_ENV: DurableObjectNamespace<PrEnvironment>;
  readonly LOGTAIL: DurableObjectNamespace<LogTail>;
  readonly PROVISION_RUNNER: DurableObjectNamespace<ProvisionRunner>;
  readonly TEARDOWN_RUNNER: DurableObjectNamespace<TeardownRunner>;

  // ── Analytics Engine ──────────────────────────────────────────────────────
  readonly ANALYTICS: AnalyticsEngineDataset;

  // ── Workers for Platforms dispatch namespace ──────────────────────────────
  readonly DISPATCHER: DispatchNamespace;

  // ── Secrets (wrangler secrets / .dev.vars) ────────────────────────────────
  // Free-tier substitution: PRD §13 specifies Secrets Store, but for v1 demo
  // we use the standard `wrangler secret put` mechanism. Production deployment
  // would migrate these to a Secrets Store binding without changing call sites.
  readonly GITHUB_APP_PRIVATE_KEY: string;
  readonly GITHUB_WEBHOOK_SECRET: string;
  readonly SESSION_SIGNING_KEY: string;
  readonly INTERNAL_DISPATCH_SECRET: string;

  /**
   * Single CF API token used for ALL provisioning (read directly instead of
   * looking up per-installation tokens in Secrets Store). Production path
   * goes through `installations.cloudflare_token_secret_id`.
   * TODO(raft:slice-G) — wire per-installation tokens via the connect endpoint.
   */
  readonly CF_API_TOKEN: string;

  // ── Static assets (the dashboard SPA) ─────────────────────────────────────
  readonly ASSETS: Fetcher;
}

/**
 * Provisioning + teardown params (PRD §9.1, §10). Consumed by the
 * ProvisionRunner / TeardownRunner DOs (Slice D / E).
 */
export interface ProvisionPRParams {
  readonly installationId: string;
  readonly repoFullName: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseBranch: string;
  readonly triggerActor: string;
}

export interface TeardownPRParams {
  readonly prEnvId: string;
  readonly reason: 'pr_closed' | 'idle_7d' | 'manual' | 'failed';
}

/**
 * Discriminated union of messages sent through the EVENTS queue.
 * Each message carries everything the consumer needs without re-parsing
 * raw GitHub payloads (which the webhook handler has already validated).
 */
export interface PrPayload {
  readonly installationId: string;
  readonly repoFullName: string;
  readonly githubRepoId: number;
  readonly defaultBranch: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly baseBranch: string;
  readonly actorLogin: string;
}

export interface InstallationPayload {
  readonly installationId: string;
  readonly githubAccount: string;
  readonly githubAccountId: number;
  readonly accountType: 'user' | 'organization';
}

export interface InstallationReposPayload {
  readonly installationId: string;
  readonly added: { id: number; full_name: string; default_branch: string }[];
  readonly removed: { id: number; full_name: string }[];
}

/**
 * raft-tail-events queue payload — Tail Worker forwards each per-script
 * trace event into the LogTail DO via this queue (PRD amendment A5).
 */
export interface TailEvent {
  readonly scriptName: string;
  readonly prEnvId?: string;
  readonly events: unknown[];
}

export type RaftQueueMessage =
  | { readonly kind: 'pr.opened';        readonly payload: PrPayload; readonly deliveryId: string }
  | { readonly kind: 'pr.synchronize';   readonly payload: PrPayload; readonly deliveryId: string }
  | { readonly kind: 'pr.reopened';      readonly payload: PrPayload; readonly deliveryId: string }
  | { readonly kind: 'pr.closed';        readonly payload: PrPayload; readonly deliveryId: string }
  | { readonly kind: 'installation.created';            readonly payload: InstallationPayload; readonly deliveryId: string }
  | { readonly kind: 'installation.deleted';            readonly payload: InstallationPayload; readonly deliveryId: string }
  | { readonly kind: 'installation_repositories.added'; readonly payload: InstallationReposPayload; readonly deliveryId: string }
  | { readonly kind: 'installation_repositories.removed'; readonly payload: InstallationReposPayload; readonly deliveryId: string };
