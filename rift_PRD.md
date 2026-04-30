# Raft — Product & Engineering Requirements Document (v1.0)

> **Per-Pull-Request ephemeral preview environments for Cloudflare Workers — with fully isolated D1, Durable Objects, R2, KV, and Queues. Built entirely on Cloudflare.**
>
> This document is the single source of truth for the Raft v1 backend. It is written to be handed verbatim to Claude Code in VS Code, an engineering hire, or another AI coding agent. Every API, schema, binding name, environment variable, and task is specified concretely. Where Cloudflare's primitives have constraints, those constraints are called out and worked around.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Goals, Non-Goals, and Success Metrics](#2-goals-non-goals-and-success-metrics)
3. [System Architecture](#3-system-architecture)
4. [Cloudflare Resource Inventory](#4-cloudflare-resource-inventory)
5. [Repository Layout](#5-repository-layout)
6. [Control-Plane Database Schema (D1)](#6-control-plane-database-schema-d1)
7. [Durable Object Designs](#7-durable-object-designs)
8. [HTTP API Contract (Internal + GitHub Webhooks)](#8-http-api-contract-internal--github-webhooks)
9. [The Provisioning Engine — Step-by-Step](#9-the-provisioning-engine--step-by-step)
10. [The Tear-Down Engine](#10-the-tear-down-engine)
11. [The Cloudflare API Client](#11-the-cloudflare-api-client)
12. [Security Model](#12-security-model)
13. [Environment Variables and Secrets](#13-environment-variables-and-secrets)
14. [Wrangler Configuration](#14-wrangler-configuration)
15. [Local Development Setup](#15-local-development-setup)
16. [Testing Strategy](#16-testing-strategy)
17. [Observability and Operations](#17-observability-and-operations)
18. [Day-by-Day Build Plan for Claude Code](#18-day-by-day-build-plan-for-claude-code)
19. [Appendix A — Critical Cloudflare Caveats Discovered During Spec](#19-appendix-a--critical-cloudflare-caveats-discovered-during-spec)
20. [Appendix B — Coding Standards & Conventions](#20-appendix-b--coding-standards--conventions)

---

## 1. Executive Summary

### 1.1 The product in one paragraph

Raft is a GitHub App. A team installs it on a repository that deploys to Cloudflare Workers. When a developer opens a pull request, Raft automatically provisions a fully isolated preview environment for that PR — its own D1 database (forked from the base branch's data), its own Durable Object namespace shard, its own R2 prefix, its own KV namespace, and its own Queue — and deploys the PR's Worker code into a Workers-for-Platforms dispatch namespace. The preview is reachable at `pr-<n>.preview.<your-domain>`, optionally gated behind Cloudflare Access. When the PR is closed or merged, every resource is destroyed automatically. A nightly cron sweeps stale environments.

### 1.2 Why now

Three Cloudflare primitives that landed in 2024–2026 make this practical for the first time:

1. **D1 export/import REST API** lets us "fork" a database in seconds without copying storage.
2. **Workers for Platforms dispatch namespaces** let us upload thousands of user Workers under a single account and route to them dynamically.
3. **One-click Cloudflare Access for `*.workers.dev`** (GA Oct 2025) gives us SSO-gated previews without manual configuration.

No competitor (Vercel, Netlify, Render, Fly) can replicate this stack because none of them ship the equivalent of D1 export/import, dispatch namespaces, or DO-namespace sharding. This is a Cloudflare-only product.

### 1.3 Critical constraints (read this before writing any code)

* **D1 Time Travel cannot fork or clone a database**, only restore in place. The official D1 docs say so explicitly: *"Time Travel does not yet allow you to clone or fork an existing database to a new copy."* The PRD therefore uses **export-to-SQL → create new DB → import-SQL** as the fork mechanism. This is the only supported pattern as of April 2026.
* **D1 export and import are blocking operations on the source database for their duration.** The control plane must throttle concurrent forks per source DB to 1.
* **D1 paid-tier limit: 50,000 databases per account, 50 GB total.** Raft must enforce its own per-tenant cap well below this and surface usage in the dashboard.
* **First-time uploads to a dispatch namespace are now synchronous** (changelog item, 2025) — a 200 OK guarantees the script is ready to handle traffic. This simplifies the provisioning sequencer.
* **Workers for Platforms is a paid add-on** ($25/month minimum). The Raft backend account must have it enabled before any provisioning will succeed.

---

## 2. Goals, Non-Goals, and Success Metrics

### 2.1 Goals (v1)

* G1. A GitHub App installable on a single repo in under 60 seconds (no Cloudflare token paste, no wrangler edits).
* G2. From `pull_request.opened` to "preview URL posted in PR comment" in **under 90 seconds for repos under 100 MB** of D1 data.
* G3. Every PR gets isolated D1, DO shard, R2 prefix, KV namespace, and Queue — verifiable by inspection.
* G4. `pull_request.closed` triggers complete tear-down within 30 seconds.
* G5. Idle environments (no commits for 7 days) are garbage-collected automatically.
* G6. The product ships as one Cloudflare account install + one GitHub App, with zero customer-side infrastructure beyond what they already have.

### 2.2 Non-goals (v1)

* NG1. Multi-region read replicas for D1 forks (Sessions API can come in v2).
* NG2. Forking Hyperdrive / external DBs (Postgres, MySQL). v1 is D1-only on the data layer.
* NG3. Custom build steps beyond `wrangler deploy` equivalents. The customer's repo must be a deployable Workers project with `wrangler.jsonc` at the root or at a configurable path.
* NG4. Multi-Worker monorepos. v1 supports one Worker per repo. v2 will use `[env]` blocks.
* NG5. Visual diff / screenshot comparison. Browser Run integration is a v1.1 nice-to-have, not blocking.
* NG6. Self-hosted control plane. Raft is SaaS-first.

### 2.3 Success metrics (first 90 days post-launch)

* M1. **Time-to-first-preview p50 < 90 seconds**, p95 < 180 seconds.
* M2. **Tear-down success rate > 99.5%** measured over rolling 7 days; orphaned resources automatically reaped within 24 h.
* M3. **Customer-side error budget**: fewer than 1 in 1,000 PR webhooks results in a "provisioning failed" comment.
* M4. **20 paying installations** by day 90.

---

## 3. System Architecture

### 3.1 High-level component diagram

```
┌────────────────────────┐                ┌─────────────────────────┐
│  GitHub                │  webhook       │  Raft Control Worker  │
│  (PR open/close/sync)  ├───────────────▶│  routes/github.ts       │
└────────────────────────┘                │  routes/api.ts          │
                                          │  routes/dashboard.ts    │
                                          └────────┬────────────────┘
                                                   │  RPC
                                                   ▼
                            ┌──────────────────────────────────────┐
                            │ Durable Objects (per-repo)           │
                            │  • RepoCoordinator (state machine)   │
                            │  • PrEnvironment   (per-PR record)   │
                            └────────┬─────────────────────────────┘
                                     │  Queue
                                     ▼
                            ┌──────────────────────────────────────┐
                            │  Provisioning Workflow (Workflows)   │
                            │  steps/provision-pr.ts               │
                            │  steps/teardown-pr.ts                │
                            └────────┬─────────────────────────────┘
                                     │  Cloudflare REST API
                                     ▼
                            ┌──────────────────────────────────────┐
                            │  Per-PR Resources                    │
                            │  • D1 (forked)        • R2 prefix    │
                            │  • DO namespace       • Queue        │
                            │  • KV namespace       • WfP script   │
                            └──────────────────────────────────────┘

                            ┌──────────────────────────────────────┐
                            │  Customer's user-Worker (deployed    │
                            │  into Raft's WfP dispatch ns)      │
                            │  Reachable at:                       │
                            │  https://pr-<n>.preview.<domain>     │
                            └──────────────────────────────────────┘
```

### 3.2 The control plane — single Worker, four entry points

A single Worker named `raft-control` is the only public-internet surface. It exposes:

* **`POST /webhooks/github`** — GitHub App webhook receiver (HMAC-SHA256 verified).
* **`/api/v1/*`** — Internal JSON API used by the dashboard SPA. Authed with Cloudflare Access JWT or a Raft session cookie issued by Access.
* **`/dashboard/*`** — Static assets (the React SPA), served via Workers static-assets binding.
* **Scheduled handler** (cron) — invoked via `crons` config at `0 4 * * *` for stale-environment GC.

There is no separate API tier. Hono is the router. All persistent state lives in Durable Objects or D1 below the control Worker.

### 3.3 The provisioning workflow

Provisioning a PR involves 7 sequential Cloudflare API calls and 1 GitHub API call. Failure at any step must (a) record the failure in the per-PR DO, (b) attempt to clean up partially-created resources, and (c) post a clear error comment on the PR with a Raft dashboard link. We use **Cloudflare Workflows** (durable, retryable steps, persists state across worker restarts) to host this orchestration. Each step is idempotent.

### 3.4 The customer's user Worker — the bundle

The customer is **not** asked to install `wrangler` differently or to change their CI. Raft reads the customer's repo at the PR's head SHA, runs `wrangler deploy --dry-run --outdir=dist` inside a Containers-backed builder (or, in v1, asks the customer to commit a pre-built bundle to a `raft-bundles` branch — see §9.4 for the v1 simplification), then re-uploads the bundle into Raft's WfP dispatch namespace with rewritten bindings.

**v1 explicit scope:** the customer commits to using `wrangler deploy --dry-run` output as input to Raft. We accept a `dist/` directory with a `worker.js` entry plus a `wrangler.jsonc` describing bindings.

---

## 4. Cloudflare Resource Inventory

These are the resources Raft must own at the **control-plane account** level. They are created once at install time (or via a Terraform script) and configured by environment variable.

| Resource | Purpose | Created |
|---|---|---|
| `raft-control` Worker | Public entry point, routes, dashboard, webhook | `wrangler deploy` |
| `raft-meta` D1 database | Customer accounts, installations, billing, audit log | `wrangler d1 create raft-meta` |
| `raft-secrets` Secrets Store | Customer-supplied Cloudflare API tokens (encrypted) | Cloudflare dashboard |
| `raft-tenant-d1-templates` R2 bucket | Cached SQL exports of base-branch DBs (TTL 24h) | `wrangler r2 bucket create` |
| `raft-logs` R2 bucket | Logpush destination for the control plane and user Workers | `wrangler r2 bucket create` |
| `raft-events` Queue | Decouples webhook receipt from provisioning | `wrangler queues create` |
| `raft-tenants` WfP dispatch namespace | Holds every customer's per-PR user Worker | `wrangler dispatch-namespace create` |
| `raft-dispatcher` Worker | Routes `pr-*.preview.<domain>` traffic | `wrangler deploy` |
| `RepoCoordinator` DO class | One instance per (installation, repo) | declared in wrangler |
| `PrEnvironment` DO class | One instance per (installation, repo, prNumber) | declared in wrangler |
| `LogTail` DO class | Per-PR ring buffer for live log streaming | declared in wrangler |
| `ProvisionPR` Workflow class | The 7-step provisioning sequencer | declared in wrangler |
| `TeardownPR` Workflow class | The destruction sequencer | declared in wrangler |
| `raft-control-cache` KV namespace | GitHub installation tokens, rate-limit counters | `wrangler kv namespace create` |
| `raft_analytics` Analytics Engine dataset | Per-PR provisioning timings, failure breakdown | declared in wrangler |
| Cloudflare Access application | Gates the dashboard at `app.raft.dev` | dashboard |

This is the **complete** list. Anything not on it is not part of v1.

---

## 5. Repository Layout

```
raft/
├── apps/
│   ├── control/                       # The raft-control Worker
│   │   ├── src/
│   │   │   ├── index.ts               # Worker entry, fetch + scheduled handlers
│   │   │   ├── routes/
│   │   │   │   ├── github.ts          # POST /webhooks/github
│   │   │   │   ├── api.ts             # /api/v1/*
│   │   │   │   └── dashboard.ts       # /dashboard/* static assets
│   │   │   ├── lib/
│   │   │   │   ├── github/
│   │   │   │   │   ├── app.ts         # JWT, installation tokens
│   │   │   │   │   ├── webhooks.ts    # HMAC verify, type-narrow events
│   │   │   │   │   └── pr-comments.ts # GET/PATCH PR comments
│   │   │   │   ├── cloudflare/
│   │   │   │   │   ├── client.ts      # Typed REST client
│   │   │   │   │   ├── d1.ts          # create / export / import / delete
│   │   │   │   │   ├── kv.ts          # namespace CRUD
│   │   │   │   │   ├── queues.ts      # queue CRUD
│   │   │   │   │   ├── r2.ts          # prefix-scoped lifecycle rules
│   │   │   │   │   └── wfp.ts         # dispatch namespace + script upload
│   │   │   │   ├── auth/
│   │   │   │   │   ├── access-jwt.ts  # Verify CF Access JWT
│   │   │   │   │   └── session.ts     # Session cookie helpers
│   │   │   │   ├── crypto.ts          # AES-GCM helpers for token at rest
│   │   │   │   └── logger.ts          # Structured logger w/ request ID
│   │   │   ├── do/
│   │   │   │   ├── repo-coordinator.ts
│   │   │   │   ├── pr-environment.ts
│   │   │   │   └── log-tail.ts
│   │   │   ├── workflows/
│   │   │   │   ├── provision-pr.ts
│   │   │   │   └── teardown-pr.ts
│   │   │   ├── schemas/               # Zod schemas for every JSON payload
│   │   │   │   ├── github-events.ts
│   │   │   │   ├── api.ts
│   │   │   │   └── cloudflare-api.ts
│   │   │   └── env.ts                 # Typed Env interface, single source of truth
│   │   ├── migrations/                # D1 migrations for raft-meta
│   │   │   ├── 0001_init.sql
│   │   │   ├── 0002_audit_log.sql
│   │   │   └── 0003_billing.sql
│   │   ├── tests/
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── fixtures/
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   │
│   ├── dispatcher/                    # The raft-dispatcher Worker
│   │   ├── src/index.ts               # Routes pr-N.preview.<domain> → WfP
│   │   ├── wrangler.jsonc
│   │   └── package.json
│   │
│   └── dashboard/                     # The React SPA (built to dist/)
│       ├── src/
│       ├── index.html
│       ├── vite.config.ts
│       └── package.json
│
├── packages/
│   ├── shared-types/                  # Types shared between control + dispatcher + dashboard
│   ├── eslint-config/
│   └── tsconfig/
│
├── infra/
│   ├── terraform/                     # Optional IaC for control-plane resources
│   └── scripts/
│       ├── bootstrap.sh               # One-time setup of CF resources
│       └── seed-test-tenant.ts
│
├── .github/workflows/
│   ├── ci.yml                         # typecheck, test, build
│   └── deploy.yml                     # wrangler deploy on main
│
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── README.md
```

**Why pnpm workspaces.** Three deployable units (control, dispatcher, dashboard) plus shared types; pnpm gives the cleanest hoist behavior with Wrangler.

---

## 6. Control-Plane Database Schema (D1)

Database name: **`raft-meta`**. Migrations are stored in `apps/control/migrations/` and applied via `wrangler d1 migrations apply raft-meta`.

```sql
-- 0001_init.sql

CREATE TABLE installations (
  id                TEXT PRIMARY KEY,         -- GitHub installation_id (string)
  github_account    TEXT NOT NULL,            -- "octocat" or "octo-org"
  github_account_id INTEGER NOT NULL,
  account_type      TEXT NOT NULL CHECK(account_type IN ('user', 'organization')),
  cloudflare_account_id TEXT,                 -- The customer's CF account they want resources in
  cloudflare_token_secret_id TEXT,            -- Reference into Secrets Store
  plan              TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free', 'pro', 'team')),
  active            INTEGER NOT NULL DEFAULT 1,
  installed_at      INTEGER NOT NULL,         -- unix seconds
  uninstalled_at    INTEGER,
  config_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_installations_active ON installations(active) WHERE active = 1;

CREATE TABLE repos (
  id                TEXT PRIMARY KEY,         -- "{installation_id}:{full_name}"
  installation_id   TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  github_repo_id    INTEGER NOT NULL,
  full_name         TEXT NOT NULL,            -- "octo-org/api"
  default_branch    TEXT NOT NULL DEFAULT 'main',
  base_d1_id        TEXT,                     -- The base-branch D1 we fork from
  base_kv_id        TEXT,                     -- The base KV namespace
  base_r2_bucket    TEXT,                     -- The base R2 bucket (we use prefixes within)
  base_queue_name   TEXT,
  do_class_names    TEXT NOT NULL DEFAULT '[]', -- JSON array of DO class names in customer's worker
  raft_config_json TEXT NOT NULL DEFAULT '{}',-- Overrides committed at .raft.json
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_repos_installation ON repos(installation_id);

CREATE TABLE pr_environments (
  id                TEXT PRIMARY KEY,         -- "{repo_id}:{pr_number}"
  repo_id           TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number         INTEGER NOT NULL,
  state             TEXT NOT NULL CHECK(state IN (
                      'pending','provisioning','ready','updating',
                      'failed','tearing_down','torn_down')),
  state_reason      TEXT,
  head_sha          TEXT NOT NULL,
  preview_hostname  TEXT,                     -- pr-123.preview.<domain>
  workflow_id       TEXT,                     -- ID of the active Workflow run
  -- Resource handles (each may be null until created)
  d1_database_id    TEXT,
  kv_namespace_id   TEXT,
  queue_id          TEXT,
  wfp_script_name   TEXT,                     -- "{installation}-{repo_short}-pr-{n}"
  r2_prefix         TEXT,                     -- "tenants/{installation}/{repo}/pr-{n}/"
  do_namespace_seed TEXT,                     -- Used to derive DO names: "pr-{n}"
  -- Lifecycle
  created_at        INTEGER NOT NULL,
  ready_at          INTEGER,
  last_activity_at  INTEGER NOT NULL,
  torn_down_at      INTEGER,
  UNIQUE(repo_id, pr_number)
);
CREATE INDEX idx_pr_envs_state    ON pr_environments(state);
CREATE INDEX idx_pr_envs_activity ON pr_environments(last_activity_at);

CREATE TABLE deployments (
  id              TEXT PRIMARY KEY,           -- ULID
  pr_env_id       TEXT NOT NULL REFERENCES pr_environments(id) ON DELETE CASCADE,
  head_sha        TEXT NOT NULL,
  bundle_r2_key   TEXT NOT NULL,              -- Where we cached the worker bundle
  status          TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
  error_message   TEXT,
  duration_ms     INTEGER,
  started_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX idx_deployments_pr ON deployments(pr_env_id, started_at);
```

```sql
-- 0002_audit_log.sql
CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,           -- ULID
  installation_id TEXT NOT NULL,
  actor           TEXT NOT NULL,              -- 'github-webhook', 'cron', or user email
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_install_time ON audit_log(installation_id, created_at DESC);
```

```sql
-- 0003_billing.sql
CREATE TABLE usage_records (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  period_start    INTEGER NOT NULL,           -- unix seconds, day-bucketed
  period_end      INTEGER NOT NULL,
  pr_envs_active  INTEGER NOT NULL DEFAULT 0,
  pr_envs_created INTEGER NOT NULL DEFAULT 0,
  d1_size_bytes   INTEGER NOT NULL DEFAULT 0,
  r2_size_bytes   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(installation_id, period_start)
);
```

**Note on D1 best practices.** All FKs use `ON DELETE CASCADE` so customer uninstall is a single delete on `installations`. All timestamps are unix-seconds integers (D1's SQLite has no `TIMESTAMPTZ`; integers sort and compare fastest). All enum-like fields use `CHECK` constraints to fail loudly on bad writes.

---

## 7. Durable Object Designs

We use three DO classes. Each has one job. None is more than ~300 lines of TypeScript.

### 7.1 `RepoCoordinator` — one per (installation, repo)

**Identity.** `env.REPO.idFromName(`${installationId}:${repoFullName}`)`

**Storage.** SQLite-backed (DO storage API). Holds:
* `config: RaftRepoConfig` — parsed from the customer's `.raft.json` (last seen)
* `active_pr_count: number`
* `provisioning_lock: boolean` — single-flight on shared resources (D1 export of base)
* Active `pr_environments` index for fast listing

**Methods (RPC).**
```ts
class RepoCoordinator extends DurableObject {
  async onPrOpened(ev: PrOpenedEvent): Promise<{ workflowId: string }>;
  async onPrSync(ev: PrSyncEvent): Promise<{ workflowId: string }>;
  async onPrClosed(ev: PrClosedEvent): Promise<{ workflowId: string }>;
  async listPrs(): Promise<PrEnvSummary[]>;
  async invalidateBaseExport(): Promise<void>;  // when base branch advances
  async refreshRaftConfig(headSha: string): Promise<RaftRepoConfig>;
}
```

**Concurrency rule.** Inside `onPrOpened`/`onPrSync`, the coordinator acquires the `provisioning_lock` if the base D1 export is stale (>10 minutes old) or missing, kicks off a one-shot export workflow, then releases the lock. All in-flight PR provisioners wait on the same export — this is the throttle described in §1.3.

### 7.2 `PrEnvironment` — one per PR

**Identity.** `env.PR_ENV.idFromName(`${repoId}:${prNumber}`)`

**Storage.** Holds the canonical `pr_environments` row plus a small log buffer. The D1 row in `raft-meta` is the durable record; the DO is the **state machine** and **single-writer** (so we never get into a torn state where two events race to update the same PR).

**Methods.**
```ts
class PrEnvironment extends DurableObject {
  async getState(): Promise<PrEnvState>;
  async transitionTo(state: PrEnvState['state'], reason?: string): Promise<void>;
  async recordResource(kind: ResourceKind, handle: string): Promise<void>;
  async appendLog(line: string): Promise<void>;
  async tailLogs(opts: { since?: number }): Promise<{ lines: LogLine[]; cursor: number }>;
}
```

The state machine is strictly:
`pending → provisioning → ready → updating → ready → tearing_down → torn_down`
with `failed` reachable from any non-terminal state.

### 7.3 `LogTail` — one per PR (dual-purpose)

Receives Tail Worker output for the user-Worker via a Queue, buffers the last 5 minutes (~5,000 lines) in memory + DO storage, and serves WebSocket subscribers in the dashboard. Uses `state.acceptWebSocket()` (Hibernatable WebSockets API) so a single DO can serve up to 32,768 concurrent dashboard tabs without consuming connection-time billing.

---

## 8. HTTP API Contract (Internal + GitHub Webhooks)

### 8.1 Webhook endpoint

**`POST /webhooks/github`** — open to internet, HMAC-verified.

* Signature header: `X-Hub-Signature-256`
* Verification: `crypto.subtle` HMAC-SHA256 with `GITHUB_WEBHOOK_SECRET`. Use timing-safe comparison.
* On verification failure → `401`, no body, no log of the request body.
* Events handled in v1:
  * `pull_request.opened` → enqueue `provision`
  * `pull_request.synchronize` → enqueue `update` (rebuild bundle, redeploy)
  * `pull_request.reopened` → enqueue `provision`
  * `pull_request.closed` → enqueue `teardown`
  * `installation.created` / `installation.deleted` → upsert/soft-delete row in `installations`
  * `installation_repositories.added` / `.removed` → upsert/delete in `repos`
* All other events → `204`, ignored.
* Response time goal: `<200ms`. We accept and enqueue, never block.

### 8.2 Internal API (`/api/v1`)

All routes return JSON. All routes require either:
* A valid `Cf-Access-Jwt-Assertion` header (verified against your Access app's JWKS), or
* A signed Raft session cookie issued after Access SSO.

Schema validation is **mandatory** on every request body via Zod. Reject with 422 on failure.

```
GET    /api/v1/installations
GET    /api/v1/installations/:id
PATCH  /api/v1/installations/:id              { plan?, config? }

GET    /api/v1/installations/:id/repos
GET    /api/v1/repos/:repoId
PATCH  /api/v1/repos/:repoId/config           { base_d1_id?, ... }

GET    /api/v1/repos/:repoId/prs
GET    /api/v1/prs/:prEnvId
POST   /api/v1/prs/:prEnvId/teardown          (manual force teardown)
POST   /api/v1/prs/:prEnvId/redeploy          (rebuild + redeploy)
GET    /api/v1/prs/:prEnvId/logs/stream       (WebSocket → LogTail DO)

GET    /api/v1/usage/:installationId
GET    /api/v1/audit/:installationId

POST   /api/v1/cloudflare/connect             { account_id, api_token }   // store token in Secrets Store
DELETE /api/v1/cloudflare/connect
```

### 8.3 Common response shape

```ts
type ApiOk<T>  = { ok: true; data: T; request_id: string };
type ApiErr    = { ok: false; error: { code: string; message: string; details?: unknown }; request_id: string };
```

Errors use a stable error-code taxonomy declared in `apps/control/src/lib/errors.ts` (e.g. `E_AUTH`, `E_NOT_FOUND`, `E_CF_API`, `E_GITHUB_API`, `E_VALIDATION`, `E_QUOTA`).

---

## 9. The Provisioning Engine — Step-by-Step

The `ProvisionPR` Workflow runs the following steps. Each step calls `step.do(name, { retries: { ... } }, async () => { ... })` so Cloudflare Workflows handles retries and persistence. Step names match the audit log entries.

### 9.1 Inputs (Workflow params)

```ts
type ProvisionParams = {
  installationId: string;
  repoFullName: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  triggerActor: string;          // "github-webhook" or user email for manual
};
```

### 9.2 Step 1 — `load-config`

* RPC into `RepoCoordinator.refreshRaftConfig(headSha)`.
* Fetches `.raft.json` from the head SHA via GitHub `contents` API.
* Validates against Zod `RaftRepoConfig`. Default config below.
* If invalid → mark PR env `failed`, post PR comment with link to docs, end workflow.

```jsonc
// .raft.json — default schema
{
  "version": 1,
  "worker_path": ".",                // dir containing wrangler.jsonc
  "bundle_command": "wrangler deploy --dry-run --outdir=dist",
  "bindings_to_isolate": ["DB", "KV", "QUEUE", "BUCKET"],
  "do_classes_to_shard": ["ChatRoom", "Counter"],
  "max_d1_export_size_mb": 100,
  "access_required": false,
  "ttl_days": 7
}
```

### 9.3 Step 2 — `prepare-base-export`

* Acquire export-lock on the `RepoCoordinator`.
* If a fresh (<10 min) base-D1 export exists in R2 (`raft-tenant-d1-templates`), skip.
* Otherwise, call **D1 Export API**:
  ```
  POST /accounts/{account_id}/d1/database/{base_d1_id}/export
  Body: { "output_format": "polling" }
  ```
* Poll until `status === "complete"`. Cloudflare returns a `signed_url`; we `fetch` it and stream to R2 at `bases/{repo_id}/{baseSha}.sql`.
* Release export-lock.

### 9.4 Step 3 — `await-bundle` ✅ SHIPPED in v0.2.0

**Implementation note**: see Day-2 amendment D1. Diverged from the original
design: payload is JSON not zip (no parser dep in worker), storage is
`BUNDLES_KV` not R2 (free tier), and the wait is via DO-alarm polling
not a D1 polling loop.

* Customer adds one GitHub Action job `raft-bundle.yml` (provided on the
  dashboard Settings page). It runs `wrangler deploy --dry-run
  --outdir=dist`, base64-encodes each module, and POSTs JSON
  `{wrangler, modules: [{name, content_b64, type}]}` to
  `https://<your-control>.workers.dev/api/v1/bundles/upload` with
  `Authorization: Bearer <repo upload token>` + headers
  `X-Raft-Repo-Id` + `X-Raft-Head-Sha`.
* The control Worker validates with Zod, then stores the JSON in
  `BUNDLES_KV` at `bundle:{installation}:{repo}:{headSha}`.
* The new `await-bundle` provisioning step polls `BUNDLES_KV` every 2s up
  to a 5-min cap. No-op for `static-synth` and `fallback` modes —
  returns immediately.

**Why JSON, not zip.** Avoids pulling a zip-parser into the worker (size
+ vulnerability surface). Customer's GH Action does the encoding via a
~10-line node inline script; the worker just decodes per-module on
upload-script.

**Why KV, not R2.** Free-tier R2 has no API on Workers Free. KV value cap
is 24 MB which is comfortably above typical Worker bundles (most under 1
MB after `wrangler deploy --dry-run`). Production / paid path can swap
to R2 by changing only the storage helper.

**v2 plan.** Run builds inside Cloudflare Containers with a sandboxed
build image so customers don't need to add a workflow at all.

### 9.5 Step 4 — `provision-resources`

In parallel (Promise.all) with hard 30s timeouts each:

* **D1 fork:**
  1. `POST /accounts/{a}/d1/database` body `{ "name": "raft-{repo}-pr-{n}-{shortSha}" }` → returns `database.uuid`.
  2. Read base SQL from R2; call **D1 Import API** in chunks (5 MB max per request; use `action: 'init'` then `action: 'ingest'` per docs).
  3. Poll until `status === "complete"`.
  4. Write `d1_database_id` to PR env DO.
* **KV namespace:** `POST /accounts/{a}/storage/kv/namespaces` body `{ "title": "raft-{repo}-pr-{n}" }`.
* **Queue:** `POST /accounts/{a}/queues` body `{ "queue_name": "raft-{repo}-pr-{n}" }`.
* **R2 prefix:** No API call — prefix is `tenants/{installation}/{repo}/pr-{n}/`. We add a 14-day **lifecycle rule** scoped to that prefix at the Raft root bucket via the R2 lifecycle API for hygiene.
* **DO namespace:** No API call — the customer's Worker code uses `env.{CLASS}.idFromName('pr-{n}:' + userScopedKey)`, which we enforce via a code-rewrite step (see §9.6).

If any sub-step fails after retries → enter `failed`, run a partial-teardown of any resources already created.

### 9.6 Step 5 — `rewrite-bundle`

Take the customer's uploaded bundle, parse `wrangler.jsonc`, and produce a Raft-rewritten metadata payload for WfP upload. The rewrite:

* Replaces `database_id` of the `d1_databases` binding named `DB` (or whatever `bindings_to_isolate` lists) with the new fork's UUID.
* Replaces `kv_namespaces` IDs.
* Replaces `queues` producer/consumer `queue` names.
* For each DO class in `do_classes_to_shard`, wraps the namespace binding such that every `idFromName(name)` automatically prepends `pr-{n}:`. Implementation: we inject a tiny pre-bundled module at `__raft_rewrite__.js` that monkey-patches `DurableObjectNamespace.prototype.idFromName` and `getByName` on import. The user's code does not change.
* Sets `R2_PREFIX` env var to `tenants/{installation}/{repo}/pr-{n}/`. The customer is expected to use a tiny `raft-r2-prefix` helper (we publish on npm) or to opt-in to a wrapper binding `BUCKET_PREFIXED`.

### 9.7 Step 6 — `upload-to-wfp`

`PUT /accounts/{a}/workers/dispatch/namespaces/raft-tenants/scripts/{script_name}` with `multipart/form-data`:
* `metadata` JSON: `main_module`, rewritten `bindings`, `compatibility_date`, `tags: ["installation:<id>", "repo:<id>", "pr:<n>"]`.
* The rewritten `worker.mjs` plus any sub-modules.

The 200 OK on first upload guarantees the script is ready (per Cloudflare changelog, 2025).

### 9.8 Step 7 — `route-and-comment`

* Compute `preview_hostname = `pr-${n}.${repoSlug}.preview.${RAFT_BASE_DOMAIN}``. Hostnames are claimed by the dispatcher Worker via a single wildcard Worker route `*.preview.<base>`.
* Post a sticky comment on the PR via GitHub API:
  ```
  ### 🌿 Raft preview

  **URL:** https://pr-42.octo-org-api.preview.raft.dev
  **Status:** ✅ Ready (provisioned in 73s)
  **Resources:** D1 forked from `main@a3f9c2b`, isolated KV, Queue, DO shard
  **Logs:** https://app.raft.dev/p/abc123/logs
  ```
* Transition PR env DO to `ready`.

### 9.9 Update flow (sync events)

`pull_request.synchronize` runs steps 3, 5, 6, 7 only — re-uses the existing D1, KV, Queue. The PR comment is **edited in place** (we store its `comment_id`).

---

## 10. The Tear-Down Engine

`TeardownPR` Workflow steps. Idempotent — can be re-run on any partially-torn-down PR.

1. **`mark-tearing-down`** — DO state transition.
2. **`delete-wfp-script`** — `DELETE /accounts/{a}/workers/dispatch/namespaces/raft-tenants/scripts/{name}`.
3. **`delete-d1`** — `DELETE /accounts/{a}/d1/database/{id}`.
4. **`delete-kv`** — `DELETE /accounts/{a}/storage/kv/namespaces/{id}`.
5. **`delete-queue`** — `DELETE /accounts/{a}/queues/{id}`.
6. **`purge-r2-prefix`** — list + bulk-delete every key under `tenants/{i}/{r}/pr-{n}/`. Use the R2 list-and-delete pattern (1,000 keys per call).
7. **`evict-do-shard`** — list active DO IDs with namespace prefix `pr-{n}:` via `env.{CLASS}.list({ prefix: 'pr-{n}:' })` (DO list API exists for SQLite-backed DOs); for each, `stub.fetch('https://internal/__raft_destroy__')`. This requires the customer to opt-in by adding a tiny handler in their DO base class — published as `@raft/do-cleanup`.
8. **`update-pr-comment`** — replace with "🌿 Raft preview torn down ✅".
9. **`mark-torn-down`** — DO + D1 row update; emit Analytics Engine event with total environment lifetime.

**Garbage collector cron** (daily at 04:00 UTC):
```ts
async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
  const stale = await env.DB.prepare(
    `SELECT id FROM pr_environments
     WHERE state = 'ready' AND last_activity_at < ?
     LIMIT 100`
  ).bind(sevenDaysAgo).all();
  for (const row of stale.results) {
    ctx.waitUntil(env.TEARDOWN.create({ params: { prEnvId: row.id, reason: 'idle_7d' } }));
  }
}
```

---

## 11. The Cloudflare API Client

A single file (`lib/cloudflare/client.ts`) wraps `fetch` with:

* Exponential backoff on `429`/`5xx` with jitter (max 5 retries).
* Per-account-token rate-limiting using a sliding-window counter in the `raft-control-cache` KV.
* Structured logging of every call with `request_id` and **redacted token**.
* Strong typing via Zod schemas for the **subset** of CF API we use. Do not use the official SDK in v1 — it's heavy and opinionated; a thin custom client is cleaner for this surface area.

```ts
// lib/cloudflare/client.ts (skeleton)
export class CFClient {
  constructor(private accountId: string, private token: string, private env: Env) {}

  async req<T>(method: string, path: string, body?: unknown, schema?: ZodSchema<T>): Promise<T> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.accountId}${path}`;
    const reqId = crypto.randomUUID();
    // ... retries, rate-limit, logger, schema.parse
  }

  d1 = {
    create: (name: string) => this.req('POST', '/d1/database', { name }, D1CreateSchema),
    delete: (id: string) => this.req('DELETE', `/d1/database/${id}`),
    exportStart: (id: string) => this.req('POST', `/d1/database/${id}/export`, { output_format: 'polling' }, D1ExportSchema),
    exportPoll:  (id: string, bookmark: string) => this.req('POST', `/d1/database/${id}/export`, { current_bookmark: bookmark }, D1ExportSchema),
    importInit:  (id: string, etag: string) => this.req('POST', `/d1/database/${id}/import`, { action: 'init', etag }, D1ImportSchema),
    importIngest:(id: string, etag: string, filename: string) => this.req('POST', `/d1/database/${id}/import`, { action: 'ingest', etag, filename }, D1ImportSchema),
  };

  kv = { /* ... */ };
  queues = { /* ... */ };
  wfp = {
    uploadScript: (ns: string, name: string, multipart: FormData) => /* fetch with FormData */,
    deleteScript: (ns: string, name: string) => this.req('DELETE', `/workers/dispatch/namespaces/${ns}/scripts/${name}`),
  };
}
```

Token storage. Customer Cloudflare API tokens go through the **Cloudflare Secrets Store**, referenced by `secret_id` in the `installations` row. The control Worker fetches them on demand via the Secrets Store binding. Tokens never live in D1 plaintext.

Token scope. The customer-supplied token must have, at minimum: `Account:Workers Scripts:Edit`, `Account:D1:Edit`, `Account:Workers KV Storage:Edit`, `Account:Queues:Edit`, `Account:R2:Edit`, `Account:Workers for Platforms:Edit`. Raft validates the token's permissions via `GET /user/tokens/verify` at install time and rejects if it can't perform a dry-run.

---

## 12. Security Model

This section is non-negotiable.

### 12.1 Trust boundaries

* **Raft control plane** — fully trusted; runs Raft code only.
* **Customer Cloudflare account** — semi-trusted; we have a delegated token. We never give the customer code access to the token.
* **Customer user-Worker** — untrusted; runs in a WfP namespace which Cloudflare guarantees executes "in untrusted mode" — no `request.cf` access, no shared cache. We additionally configure an **Outbound Worker** that logs and optionally blocks egress.
* **GitHub webhook payloads** — verified via HMAC; otherwise untrusted.

### 12.2 Concrete rules

1. **Never log token values.** The logger has a deny-list: any string matching the token regex is replaced with `<redacted:token:8chars>`.
2. **Verify GitHub webhooks every time.** No bypass for "internal" requests; there is no internal request path to webhooks.
3. **Verify Cloudflare Access JWT every time** for `/api/v1` and `/dashboard`. JWKS cached for 10 minutes.
4. **Never bind the control-plane D1 into a user Worker.** The dispatch namespace bindings are computed per-PR and contain only the PR's own resources.
5. **Per-installation rate limits** in KV: max 30 webhook events/min, max 100 API requests/min. 429 on excess.
6. **Worker outbound restriction.** The dispatcher's outbound Worker rejects any fetch destined for the Raft control domain or Cloudflare's API.
7. **Bundle scanning.** Before upload to WfP, the rewritten bundle is checked against a deny-list of suspicious patterns: `eval(`, `Function(`, dynamic import of Cloudflare API URLs. Failure → soft-warn in PR comment, do not block.
8. **Secrets Store** is used for: customer CF tokens, GitHub App private key, GitHub webhook secret, dashboard session signing key. Nothing else holds these values.

### 12.3 Threat model summary

| Threat | Mitigation |
|---|---|
| Forged GitHub webhook | HMAC verification, drop on failure |
| Malicious PR exfiltrates control-plane state | User-Worker is in WfP namespace with no access to control bindings |
| Customer leaks own data via preview URL | Optional Cloudflare Access on `*.preview.<domain>` |
| Stolen Raft CF token | Tokens in Secrets Store; rotate on suspicion; per-installation tokens are scoped to one CF account |
| Bundle includes credential exfil | Deny-list scan + outbound Worker logs all fetches |
| Resource leak on workflow failure | Tear-down workflow is idempotent; cron sweeps daily |

---

## 13. Environment Variables and Secrets

In `wrangler.jsonc` (`vars` for non-secret, `secrets` for secret):

| Name | Type | Set via | Purpose |
|---|---|---|---|
| `RAFT_BASE_DOMAIN` | var | wrangler | e.g. `raft.dev` |
| `RAFT_ENV` | var | wrangler | `production` / `staging` / `dev` |
| `GITHUB_APP_ID` | var | wrangler | numeric |
| `GITHUB_APP_CLIENT_ID` | var | wrangler | |
| `GITHUB_APP_PRIVATE_KEY` | secret | Secrets Store | RSA private key, PEM |
| `GITHUB_WEBHOOK_SECRET` | secret | Secrets Store | for HMAC |
| `CF_OWN_ACCOUNT_ID` | var | wrangler | the account hosting Raft itself |
| `CF_DISPATCH_NAMESPACE` | var | wrangler | `raft-tenants` |
| `ACCESS_AUD` | var | wrangler | Cloudflare Access app AUD tag |
| `ACCESS_TEAM_DOMAIN` | var | wrangler | `raft.cloudflareaccess.com` |
| `SESSION_SIGNING_KEY` | secret | Secrets Store | HMAC key for session cookies |

The control Worker imports these via the typed `Env` interface in `apps/control/src/env.ts`. **Every binding declared in `wrangler.jsonc` MUST appear in `Env`.** This is enforced by a typecheck in CI.

---

## 14. Wrangler Configuration

`apps/control/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "raft-control",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-29",
  "compatibility_flags": ["nodejs_compat"],

  "observability": { "enabled": true },

  "routes": [
    { "pattern": "api.raft.dev/*", "zone_name": "raft.dev" },
    { "pattern": "app.raft.dev/*", "zone_name": "raft.dev" }
  ],

  "vars": {
    "RAFT_BASE_DOMAIN": "raft.dev",
    "RAFT_ENV": "production",
    "GITHUB_APP_ID": "0",
    "CF_OWN_ACCOUNT_ID": "REPLACE_ME",
    "CF_DISPATCH_NAMESPACE": "raft-tenants",
    "ACCESS_TEAM_DOMAIN": "raft.cloudflareaccess.com",
    "ACCESS_AUD": "REPLACE_ME"
  },

  "d1_databases": [
    { "binding": "DB", "database_name": "raft-meta", "database_id": "REPLACE_ME",
      "migrations_dir": "migrations" }
  ],

  "kv_namespaces": [
    { "binding": "CACHE", "id": "REPLACE_ME" }
  ],

  "r2_buckets": [
    { "binding": "TEMPLATES", "bucket_name": "raft-tenant-d1-templates" },
    { "binding": "BUNDLES",   "bucket_name": "raft-bundles" },
    { "binding": "LOGS",      "bucket_name": "raft-logs" }
  ],

  "queues": {
    "producers": [{ "binding": "EVENTS", "queue": "raft-events" }],
    "consumers": [{
      "queue": "raft-events",
      "max_batch_size": 10,
      "max_batch_timeout": 2,
      "max_retries": 5,
      "dead_letter_queue": "raft-events-dlq"
    }]
  },

  "workflows": [
    { "name": "provision-pr", "binding": "PROVISION", "class_name": "ProvisionPR" },
    { "name": "teardown-pr",  "binding": "TEARDOWN",  "class_name": "TeardownPR" }
  ],

  "durable_objects": {
    "bindings": [
      { "name": "REPO",    "class_name": "RepoCoordinator" },
      { "name": "PR_ENV",  "class_name": "PrEnvironment" },
      { "name": "LOGTAIL", "class_name": "LogTail" }
    ]
  },

  "migrations": [
    { "tag": "v1",
      "new_sqlite_classes": ["RepoCoordinator", "PrEnvironment", "LogTail"] }
  ],

  "analytics_engine_datasets": [
    { "binding": "ANALYTICS", "dataset": "raft_analytics" }
  ],

  "dispatch_namespaces": [
    { "binding": "DISPATCHER", "namespace": "raft-tenants" }
  ],

  "secrets_store_secrets": [
    { "binding": "GITHUB_APP_PRIVATE_KEY", "store_id": "REPLACE_ME", "secret_name": "github-app-private-key" },
    { "binding": "GITHUB_WEBHOOK_SECRET",  "store_id": "REPLACE_ME", "secret_name": "github-webhook-secret" },
    { "binding": "SESSION_SIGNING_KEY",    "store_id": "REPLACE_ME", "secret_name": "session-signing-key" }
  ],

  "triggers": {
    "crons": ["0 4 * * *"]
  },

  "assets": { "directory": "../dashboard/dist", "binding": "ASSETS" }
}
```

`apps/dispatcher/wrangler.jsonc`:

```jsonc
{
  "name": "raft-dispatcher",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-29",
  "routes": [
    { "pattern": "*.preview.raft.dev/*", "zone_name": "raft.dev" }
  ],
  "dispatch_namespaces": [
    { "binding": "DISPATCHER", "namespace": "raft-tenants" }
  ],
  "observability": { "enabled": true }
}
```

---

## 15. Local Development Setup

```bash
# Prereqs: Node 22, pnpm 9, Wrangler 3.96+
git clone git@github.com:<you>/raft.git
cd raft
pnpm install

# 1. Bootstrap CF resources (idempotent; reads .env)
pnpm exec tsx infra/scripts/bootstrap.ts

# 2. Apply D1 migrations
pnpm --filter @raft/control exec wrangler d1 migrations apply raft-meta --remote

# 3. Run control Worker locally (with --remote so DOs persist; Workflows need real backend)
pnpm --filter @raft/control dev

# 4. Tunnel for GitHub webhooks (Raft ships its own TUNNEL helper)
pnpm exec tsx infra/scripts/tunnel-github.ts
# → prints: Webhook URL set on GitHub App: https://abcd-1234.trycloudflare.com/webhooks/github
```

`infra/scripts/bootstrap.ts` is idempotent and creates: `raft-meta` D1, `raft-tenant-d1-templates`/`raft-bundles`/`raft-logs` R2 buckets, `raft-events`/`raft-events-dlq` queues, `raft-tenants` dispatch namespace, `raft-control-cache` KV, `raft_analytics` Analytics Engine dataset.

---

## 16. Testing Strategy

Three test layers; each layer's command is `pnpm test:<layer>`.

* **`unit`** (Vitest, in-memory):
  * Pure functions: HMAC verifier, JWT verifier, bundle rewriter, error taxonomy, schemas.
  * Coverage target: 90%+ on `lib/`.
* **`integration`** (Vitest with `@cloudflare/workers-vitest-pool`):
  * Spin up `raft-control` against a local Miniflare instance.
  * Mock the Cloudflare REST API with MSW. Verify each step of the provisioning workflow against captured request fixtures.
  * Mock GitHub API similarly.
  * Verify state machine transitions in the DOs end-to-end.
* **`e2e`** (Playwright + a sandbox CF account):
  * One real test repo, one real installation. Open a PR, assert preview URL responds 200 within 120s, close the PR, assert preview URL 404s within 60s.

CI runs `unit` + `integration` on every PR. `e2e` runs nightly on `main`.

---

## 17. Observability and Operations

* **Workers Logs (Logpush)** — pushed to R2 `raft-logs` with 30-day retention. JSON format. Log shape: `{ ts, level, request_id, installation_id, pr_env_id?, msg, ...meta }`.
* **Workflows trace UI** — included by default in dashboard for every Provision/Teardown run.
* **Analytics Engine dataset `raft_analytics`** — one event per state transition with dimensions: installation, repo, pr, state, prev_state, duration_ms. Queryable via the Analytics Engine SQL API. Surfaced in the dashboard's `Reliability` tab.
* **Alerts (set in CF dashboard)**:
  * Workflow failure rate > 1% over 1 h → page on-call.
  * Provisioning p95 latency > 180 s over 1 h → warn.
  * `pr_environments` count where `state='failed' AND torn_down_at IS NULL` > 10 → page.
* **Runbooks** — `infra/runbooks/` contains markdown for: stuck workflow, leaked D1, GitHub App outage, CF API token compromised. Each has explicit `wrangler` and `curl` commands.

---

## 18. Day-by-Day Build Plan for Claude Code

This section is **prescriptive**. Each task is ~2–4 hours. Each task has acceptance criteria. Hand them to Claude Code one at a time.

### Day 1 — Foundation
* **T1.1** Initialize pnpm monorepo with the layout in §5. Add `tsconfig.base.json`, ESLint, Prettier, Vitest, Wrangler.
* **T1.2** Implement `apps/control/src/env.ts` with the typed `Env` interface mirroring §14.
* **T1.3** Implement `apps/control/src/index.ts` with Hono router, `/healthz`, `/version`, error handling middleware, request-id middleware.
* **Acceptance:** `pnpm --filter @raft/control dev` boots, `curl localhost:8787/healthz` returns `{ ok: true }`.

### Day 2 — D1 schema + migrations + repo layer
* **T2.1** Write migrations 0001/0002/0003 from §6.
* **T2.2** Build a thin repo layer in `apps/control/src/lib/db/`: `installations.ts`, `repos.ts`, `prEnvironments.ts`, `auditLog.ts`. Each exports typed CRUD functions over the `Env['DB']` binding using prepared statements.
* **T2.3** Unit-test the repo layer against Miniflare's D1 simulator.
* **Acceptance:** all CRUD methods round-trip values; FK cascades verified.

### Day 3 — GitHub App skeleton
* **T3.1** Implement `lib/github/app.ts`: JWT signer (RSA-SHA256 via `crypto.subtle`), installation token cache in KV.
* **T3.2** Implement `lib/github/webhooks.ts`: HMAC verifier (timing-safe), Zod-typed event narrower for the 6 events in §8.1.
* **T3.3** Implement `routes/github.ts`: receive → verify → enqueue to `EVENTS` queue.
* **T3.4** Configure a GitHub App in the dev account; wire webhook to a Cloudflare Tunnel.
* **Acceptance:** `pull_request.opened` event arrives in `EVENTS` queue and is logged.

### Day 4 — DO classes
* **T4.1** Implement `do/repo-coordinator.ts` (state, locks, RPC methods from §7.1).
* **T4.2** Implement `do/pr-environment.ts` (state machine from §7.2).
* **T4.3** Implement `do/log-tail.ts` (hibernatable WebSockets, ring buffer).
* **T4.4** Wire the queue consumer in `apps/control/src/index.ts` to dispatch events into the right DO.
* **Acceptance:** integration test creates a PR-open event, ends with PR env DO in `pending`.

### Day 5 — Cloudflare API client
* **T5.1** Implement `lib/cloudflare/client.ts` with the skeleton in §11. Backoff, redaction, schema validation.
* **T5.2** Implement `lib/cloudflare/d1.ts`, `kv.ts`, `queues.ts`, `wfp.ts` using the client.
* **T5.3** MSW fixtures for every endpoint we call. Unit-test happy + error paths.
* **Acceptance:** all CF helpers green against MSW, including the multipart WfP upload.

### Day 6 — Provisioning workflow (no bundle yet)
* **T6.1** Implement `workflows/provision-pr.ts` steps 1, 2, 4, 7 (no bundle/upload yet — just provision empty resources).
* **T6.2** Wire the queue → workflow trigger.
* **Acceptance:** integration test: PR-open event → workflow runs to step 7 → PR env DO in `ready` with all four resource handles populated; CF mocks were called in correct order.

### Day 7 — Bundle upload + WfP
* **T7.1** Implement `routes/api.ts` `POST /api/v1/bundles/upload` with auth via repo-upload token, writes to R2.
* **T7.2** Implement `lib/bundle-rewriter.ts` per §9.6. Heavy unit tests.
* **T7.3** Add steps 3, 5, 6 to provisioning workflow.
* **Acceptance:** end-to-end integration test: upload a fixture bundle → workflow rewrites + uploads to mocked WfP → script_name is recorded.

### Day 8 — Dispatcher Worker + DNS
* **T8.1** Implement `apps/dispatcher/src/index.ts`: parse hostname `pr-<n>.<repo-slug>.preview.<base>` → look up script_name in KV (populated by control during step 7) → `env.DISPATCHER.get(scriptName).fetch(req)`.
* **T8.2** Configure `*.preview.raft.dev` Worker route.
* **T8.3** End-to-end test against a real Raft dev account with a tiny "hello world" Worker as the customer Worker.
* **Acceptance:** a real PR webhook ends with a real preview URL returning 200.

### Day 9 — Tear-down + cron GC
* **T9.1** Implement `workflows/teardown-pr.ts` per §10.
* **T9.2** Implement scheduled handler in `apps/control/src/index.ts`.
* **T9.3** Integration tests for idempotency: run teardown twice in a row, no errors, no duplicate work.
* **Acceptance:** `pull_request.closed` ends with all resources deleted (verified via list-after-delete).

### Day 10 — PR comments + state machine polish
* **T10.1** Implement `lib/github/pr-comments.ts`: sticky comment by `<!-- raft:hidden-id -->` HTML marker.
* **T10.2** Wire comment posting/editing into provision step 7 and teardown step 8.
* **T10.3** Add the `synchronize` flow (re-deploy without re-fork).
* **Acceptance:** open PR → comment appears; push commit → comment shows new SHA; close PR → comment shows torn-down.

### Day 11 — Auth + dashboard API
* **T11.1** Implement `lib/auth/access-jwt.ts` with JWKS caching.
* **T11.2** Implement all `/api/v1/*` GET endpoints from §8.2.
* **T11.3** Implement WebSocket route to `LogTail` DO for log streaming.
* **Acceptance:** dashboard SPA (skeleton) can authenticate via Access and list installations/repos/PRs.

### Day 12 — Hardening: rate limits, error taxonomy, retries
* **T12.1** Add per-installation rate limits (KV sliding window).
* **T12.2** Implement the full error code taxonomy in `lib/errors.ts`. Every throw must use a coded error.
* **T12.3** Add deny-list bundle scanner per §12.2.7.
* **T12.4** Set up Logpush to R2 + Workers Trace events shipping to Analytics Engine.
* **Acceptance:** a deliberately bad bundle triggers a soft-warn comment; rate-limit test trips after 30 calls/min.

### Day 13 — Manual force-teardown, redeploy, PR list UI
* **T13.1** Implement `POST /api/v1/prs/:id/teardown` and `/redeploy`.
* **T13.2** Skeletal dashboard UI: install button, repo list, PR list with status, "Force teardown" / "Redeploy".
* **T13.3** Smoke test the dashboard against a real account.
* **Acceptance:** human can manually force-teardown a PR via the dashboard.

### Day 14 — Launch checklist
* **T14.1** Production environment provisioning: prod CF account, GitHub App in prod, Access app, secrets set.
* **T14.2** Documentation pass: README, `docs/install.md`, `docs/.raft.json.md`, `docs/runbooks/*`.
* **T14.3** Onboarding flow: GitHub App install → CF token paste → repo selection → "Open a PR to test" wizard.
* **T14.4** Submit to Cloudflare Workers Launchpad; landing page deployed.
* **Acceptance:** an external developer can install Raft on a fresh repo and get a working preview within 10 minutes.

---

## 19. Appendix A — Critical Cloudflare Caveats Discovered During Spec

These are the surprises that cost real engineering hours if missed. Documented here so they don't.

1. **D1 Time Travel cannot fork or clone.** Use export → create → import. `wrangler d1 time-travel restore` overwrites in place. Clone/fork is a roadmap item with no ETA.
2. **D1 export blocks the source DB.** Throttle via `RepoCoordinator` lock (one base export at a time per repo) and cache the SQL in R2 for 10 minutes so multiple concurrent PRs reuse the same export.
3. **D1 import is also blocking.** That's fine because it blocks only the *new* fork DB, which has no traffic.
4. **D1 max DBs per account = 50,000 paid, 10 free.** Raft must enforce a per-installation quota. Default cap: 50 active PR envs per installation.
5. **Workers for Platforms is not in the free Workers plan.** $25/mo minimum. Raft's own bill, not the customer's.
6. **DO `list({ prefix })` requires the new SQLite-backed storage class.** Migrations declare `new_sqlite_classes`, never `new_classes` (legacy).
7. **Workers static-assets is one binding per Worker.** The control Worker serves the dashboard SPA; do not create a separate Pages project — it complicates auth.
8. **Cloudflare Access JWT verification needs JWKS from the team domain**, not from `cloudflare.com`. URL: `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
9. **The `nodejs_compat` flag is required** for Node-style crypto (`crypto.subtle` is fine without it; `node:crypto` is not). Use Web Crypto throughout.
10. **First-time WfP script uploads are now synchronous** (changelog 2025) — a 200 OK guarantees the script will accept traffic. Earlier docs said otherwise.
11. **WfP user Workers run in untrusted mode** — no `request.cf` access, no shared cache. This is a feature: customer code can't fingerprint Raft.
12. **Wrangler `migrations` block must list new DO classes** with the SQLite tag at every version bump. Forgetting this corrupts deploys silently.

---

## 20. Appendix B — Coding Standards & Conventions

* **TypeScript strict mode.** `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. No `any`. No `as` except in three documented places (Hono context, Workflow params, DO RPC).
* **No default exports.** Named exports only.
* **Files < 300 lines.** Above that, split.
* **Functions < 40 lines.** Above that, refactor.
* **Every external input is Zod-validated** at the boundary. Internal types are then `z.infer`'d.
* **Errors are values.** Use `Result<T, E>` for foreseeable failures, throw only for programmer errors. (Use `neverthrow` or a 30-line in-house impl.)
* **Logging.** Use the structured logger; never `console.log`. The logger is created per-request and includes `request_id`.
* **No `process.env`.** All config flows through the typed `Env` interface.
* **Idempotency keys.** Every Workflow step that calls a CF API includes the workflow run ID and step name; replays are safe.
* **Comments answer "why", not "what".** TypeScript and good names handle the "what".

---

*End of PRD v1.0. Total length ≈ 8,000 words. This document is intentionally complete: a senior engineer (or Claude Code) should be able to build Raft v1 with no additional design decisions required.*
