# Raft

**Per-PR preview environments for Cloudflare Workers projects.**

A GitHub App that, on every pull request, provisions a fully isolated Cloudflare stack — D1 + KV + Queue + Durable Object shard + a deployed Worker — comments the preview URL on the PR, and tears it all down when the PR closes. End-to-end on the Cloudflare free tier.

— [Live dashboard](https://raft-control.adityakammati3.workers.dev) · [PRD](./rift_PRD.md) · [Submission write-up](./SUBMISSION.md) · v0.2.0

---

## Why this exists

Every modern web platform — Vercel, Netlify, Render, Fly — gives reviewers a unique URL for every pull request. Cloudflare Workers does not. Reviewing a Workers PR today means picking one of three bad options:

1. **Pull the branch and `wrangler dev` locally.** Slow context switch, no shareable URL, no real bindings, breaks every reviewer workflow that relies on stakeholders clicking a link.
2. **Share one staging Worker.** Concurrent PRs collide on the same D1 / KV / Queue. One reviewer's writes corrupt another reviewer's read.
3. **Build your own per-PR provisioner.** Nobody does this — the orchestration around durable retries, idempotent resource creation, binding rewrites, and quota guarding is genuinely hard.

The Cloudflare community has been asking for this since 2022 ([workers-sdk #2701](https://github.com/cloudflare/workers-sdk/issues/2701)). Raft is the answer, designed from the ground up around Cloudflare primitives no other cloud has.

## What Raft does (the user-facing flow)

1. A team installs the **Raft GitHub App** on a Cloudflare Workers repository.
2. A developer opens a pull request.
3. Raft receives the webhook, dedups it on `delivery_id`, enqueues it, and returns `202` in under 200ms.
4. A `RepoCoordinator` Durable Object claims the PR, runs free-tier quota checks, and starts a `ProvisionRunner`.
5. The runner executes a 7-step alarm-driven machine: detect deployment mode → wait for the customer's bundle (or synthesise one for static sites) → create D1 + KV + Queue + DO shard → optionally fork the base D1 database → rewrite binding IDs in the bundle → upload the Worker script → write the dispatcher route and post a sticky PR comment with the preview URL.
6. A reviewer clicks the URL. The `raft-dispatcher` Worker resolves the path to the per-PR Worker via an HMAC-gated token and 302-redirects them in. They see a fully isolated environment — their writes never touch staging.
7. When the PR is closed or merged, a `TeardownRunner` runs a 9-step alarm machine that destroys every resource and confirms each deletion against the Cloudflare REST API.

End-to-end measured: **<2 seconds** PR-opened to ready preview URL · **<30 seconds** PR-closed to all resources deleted · **$0/mo** to operate.

## Who is this for

- **Workers teams reviewing PRs in pairs / trios.** Replace "merge to staging and pray" with click-and-review.
- **Open-source Workers maintainers.** Let drive-by contributors share a working preview without granting them deploy access.
- **Internal tools / dashboards built on Workers.** Stakeholder review without standing up per-environment infra.
- **Static-site repos hosted on Workers.** Zero customer setup — Raft synthesises a Worker that serves the inlined files.

## Three deployment modes

Raft auto-detects which mode applies by inspecting the repo at `headSha`:

| Mode                     | Trigger                                                                                 | What it deploys                                                                | Customer setup                                                             |
| ------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **Customer Worker**      | Repo has `wrangler.{jsonc,json,toml}` and the Raft GitHub Action uploads a built bundle | The customer's actual Worker code with binding ids swapped to per-PR resources | One-time: paste `.github/workflows/raft-bundle.yml` (provided on Settings) |
| **Static site**          | Repo has `index.html` under `/`, `/public`, `/dist`, `/build`, or `/site`               | A synthesised Worker that serves the inlined files (HTML / CSS / JS / images)  | None — install the GitHub App and push                                     |
| **Configuration needed** | Neither of the above                                                                    | A Worker that returns HTTP 503 with an actionable setup message                | None — surfaces what to configure                                          |

```mermaid
flowchart TD
  Start([webhook: pull_request opened]) --> Fetch[load repo tree at headSha]
  Fetch --> Wrangler{has<br/>wrangler.jsonc<br/>?}
  Wrangler -- yes --> Bundle{bundle in<br/>BUNDLES_KV?}
  Bundle -- yes --> CB[mode: Customer Worker<br/>swap binding IDs · upload]
  Bundle -- no, &lt;5min --> Wait[await-bundle:<br/>poll BUNDLES_KV]
  Wait --> Bundle
  Bundle -- no, &gt;5min --> FB[mode: Configuration needed<br/>503 with setup hint]
  Wrangler -- no --> Index{has<br/>index.html?}
  Index -- yes --> SS[mode: Static site<br/>synthesise Worker]
  Index -- no --> FB
  CB --> Done([ready])
  SS --> Done
  FB --> Done
```

All three modes are end-to-end verified against real Cloudflare resources.

---

## Architecture

Three Workers participate. `raft-control` is the brain (webhooks, API, dashboard, cron, every Durable Object). `raft-dispatcher` is the path-based router that 302-redirects reviewers into per-PR Workers. `raft-tail` is a Tail consumer scaffolded for paid-tier upgrade.

```mermaid
flowchart LR
  GH[GitHub<br/>PR opened/closed/sync]

  subgraph Edge[Cloudflare Edge]
    direction TB
    CTL[raft-control<br/>Hono · API · Dashboard · Cron]
    DISP[raft-dispatcher<br/>path-based router]
    TAIL[raft-tail<br/>Tail consumer]
  end

  subgraph DOs[Durable Objects in raft-control]
    direction TB
    REPO[RepoCoordinator]
    PRENV[PrEnvironment]
    PROV[ProvisionRunner<br/>7-step alarm machine]
    TEAR[TeardownRunner<br/>9-step alarm machine]
    LT[LogTail]
  end

  subgraph Storage[Storage]
    direction TB
    META[(D1 raft-meta)]
    CACHE[(KV CACHE)]
    ROUTES[(KV ROUTES)]
    BUNDLES[(KV BUNDLES)]
    EVQ[(Queue raft-events)]
  end

  GH -->|HMAC webhook| CTL
  CTL --> EVQ
  EVQ --> CTL
  CTL --> REPO
  REPO --> PRENV
  REPO --> PROV
  REPO --> TEAR
  PROV --> META
  PROV --> ROUTES
  PROV --> BUNDLES
  PROV -->|REST| CFAPI[Cloudflare REST API<br/>D1 · KV · Queues · Workers]
  TEAR --> CFAPI

  CFAPI -.creates.-> USER[User Worker<br/>uploaded per PR]

  BR[Browser] --> CTL
  BR --> DISP
  DISP -->|lookup| ROUTES
  DISP -->|302| USER

  CRON([Cron 04:00 UTC]) --> CTL
```

### Why three Workers, not one

| Worker            | Responsibility                                                                                                                                         | Why split out                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `raft-control`    | GitHub webhook ingress, Hono REST API, dashboard SPA, cron sweep, every Durable Object class, GitHub App auth, Cloudflare REST client, audit log writes | Single trust boundary for everything that holds secrets and writes to D1.                                              |
| `raft-dispatcher` | One path-based route. Looks up `ROUTES` KV, validates the per-scope HMAC token, 302s to the per-PR `*.workers.dev` URL.                                | Hot path for every reviewer click. Kept as small as possible so it stays cold-start-cheap and never holds App secrets. |
| `raft-tail`       | Consumes user-Worker `tail()` events into `raft-tail-events` Queue, fan out to `LogTail` DO.                                                           | Tail consumers must be a separate Worker per Cloudflare's binding model.                                               |

### Cloudflare products used

| Product                  | Used for                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Workers                  | `raft-control`, `raft-dispatcher`, `raft-tail`                                     |
| Workers Static Assets    | Dashboard SPA hosted inside `raft-control`                                         |
| Durable Objects (SQLite) | `RepoCoordinator`, `PrEnvironment`, `ProvisionRunner`, `TeardownRunner`, `LogTail` |
| D1                       | `raft-meta` for installations, repos, PR envs, audit                               |
| KV                       | Session cache (`CACHE`), dispatcher routes (`ROUTES`), bundle blobs (`BUNDLES_KV`) |
| Queues                   | Decouple webhook ingress from provisioning                                         |
| Cron Triggers            | Daily idle-environment sweep                                                       |
| Hibernatable WebSockets  | Live runner-state stream to dashboard tabs                                         |
| Workers Logs             | Operator log access via per-PR deep-links                                          |

### Why this can only exist on Cloudflare

Three Cloudflare-only primitives make this product possible. **No other cloud has the equivalent of any of them.**

1. **D1 export/import REST API** lets us fork a database in seconds without copying storage at the block layer. This is the foundation of per-PR data isolation — without it, every reviewer would either share a staging DB or wait minutes for a logical dump.
2. **Direct `PUT /workers/scripts/{name}`** lets one account host hundreds of per-PR user scripts as a free-tier substitute for Workers for Platforms. AWS Lambda, GCP Cloud Functions, Vercel — none expose a scriptable per-tenant deploy primitive at this layer.
3. **DO Alarms with SQLite-backed storage** give us durable, retryable, idempotent step machines on the free tier. We get the semantics of Cloudflare Workflows (per-step caching, exponential backoff, replay safety) without paying for them.

---

## End-to-end PR lifecycle

The full path from a developer pushing "Open PR" to a reviewer clicking the preview, then the cleanup on close.

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Developer
  participant GH as GitHub
  participant CTL as raft-control
  participant Q as raft-events Queue
  participant REPO as RepoCoordinator
  participant PROV as ProvisionRunner
  participant CF as Cloudflare REST API
  participant DISP as raft-dispatcher
  actor Rev as Reviewer

  Dev->>GH: open PR
  GH->>CTL: pull_request.opened (HMAC signed)
  CTL->>CTL: verify HMAC · dedup delivery_id · rate limit
  CTL->>Q: enqueue
  CTL-->>GH: 202 Accepted (<200ms)

  Q->>CTL: dispatch
  CTL->>REPO: dispatch(prEvent)
  REPO->>REPO: free-tier quota guard
  REPO->>PROV: kickoff(prEnvId)

  loop 7 alarm-driven steps
    PROV->>CF: create D1 / KV / Queue / DO shard
    PROV->>CF: PUT /workers/scripts/{name}
    PROV->>GH: upsert sticky PR comment
  end

  PROV-->>REPO: state = ready

  Rev->>DISP: GET preview URL
  DISP->>CTL: lookup ROUTES (KV)
  DISP-->>Rev: 302 → *.workers.dev (HMAC token + cookie)
  Rev->>CF: request to per-PR Worker
  CF-->>Rev: app response (isolated D1 + KV + Queue)

  Dev->>GH: close PR
  GH->>CTL: pull_request.closed
  CTL->>REPO: dispatch
  REPO->>PROV: teardown(prEnvId)
  loop 9 idempotent teardown steps
    PROV->>CF: DELETE D1 / KV / Queue / Worker
  end
  PROV-->>REPO: state = torn_down
```

### Provision lifecycle in detail

Seven idempotent steps, alarm-driven, exponential backoff (`1 → 2 → 4 → 8 → 16s`, max 5 attempts). Each step writes its result into DO storage so re-runs on alarm replay short-circuit. Per-step start / finish timestamps are persisted, so the dashboard latency chart reflects truth.

```mermaid
stateDiagram-v2
  [*] --> load_config: alarm fires
  load_config --> await_bundle: detect mode (customer-bundle / static / fallback)
  await_bundle --> provision_resources: bundle ready (or no-op for static / fallback)
  provision_resources --> fork_base_db: D1 + KV + Queue created (list-then-create idempotent)
  fork_base_db --> rewrite_bundle: base D1 export → import (no-op without base)
  rewrite_bundle --> upload_script: binding IDs swapped, DO wrappers codegen'd
  upload_script --> route_and_comment: PUT /workers/scripts/{name} + enable subdomain
  route_and_comment --> ready: ROUTES KV + sticky PR comment + live HTTP probe
  ready --> [*]

  load_config --> failed: 5 attempts exhausted
  await_bundle --> failed: bundle never arrived
  provision_resources --> failed
  fork_base_db --> failed
  rewrite_bundle --> failed
  upload_script --> failed
  route_and_comment --> failed
  failed --> [*]
```

**Key design decision: idempotent list-then-create.** Step 3 (`provision-resources`) handles three different "name already exists" responses (D1 returns 400+7502, KV returns 400+10014, Queue returns 409+11009) by always listing first. If the resource exists, reuse the ID; if not, create. A re-run after a partial failure picks up where it left off — never double-creates, never orphans.

### Teardown lifecycle

Nine idempotent steps. Cloudflare returning 404 is treated as success (already gone), so re-runs after a partial teardown are safe.

```mermaid
stateDiagram-v2
  [*] --> mark_tearing_down --> delete_worker_script --> delete_d1 --> delete_kv --> delete_queue --> purge_bundle_kv --> evict_do_shard --> clear_route --> mark_torn_down --> [*]
```

---

## Storage model

Four D1 tables back the operator dashboard and the runners' state machines. SQLite-backed Durable Objects hold per-PR runtime state (cursor, step cache, timings).

```mermaid
erDiagram
  installations ||--o{ repos : "1..n"
  repos ||--o{ pr_environments : "1..n"
  pr_environments ||--o{ deployments : "1..n"
  installations ||--o{ audit_log : "1..n"
  installations ||--o{ usage_records : "1..n"

  installations {
    text id PK
    text github_account
    int  github_account_id
    text account_type "user|organization"
    text cloudflare_account_id
    text plan "free|pro|team"
    int  active
    int  installed_at
    text config_json
  }

  repos {
    text id PK
    text installation_id FK
    text full_name
    text default_branch
    text base_d1_id "optional fork source"
    text base_kv_id
    text base_queue_name
    text do_class_names "JSON array"
    text upload_token_hash "for /api/v1/bundles/upload"
    int  created_at
  }

  pr_environments {
    text id PK
    text repo_id FK
    int  pr_number
    text state "pending|provisioning|ready|updating|failed|tearing_down|torn_down"
    text head_sha
    text preview_hostname
    text d1_database_id
    text kv_namespace_id
    text queue_id
    text worker_script_name
    int  pr_comment_id
    int  created_at
    int  ready_at
    int  last_activity_at
    int  torn_down_at
  }

  deployments {
    text id PK
    text pr_env_id FK
    text head_sha
    text bundle_r2_key
    text status "queued|running|succeeded|failed"
    int  duration_ms
    int  started_at
    int  finished_at
  }

  audit_log {
    text id PK
    text installation_id FK
    text actor "operator email or system"
    text action
    text target_type
    text target_id
    text metadata_json
    int  created_at
  }

  usage_records {
    text id PK
    text installation_id FK
    int  period_start
    int  period_end
    int  pr_envs_active
    int  pr_envs_created
  }
```

---

## Engineering trade-offs

The PRD targets two paid Cloudflare products; Raft substitutes both with thin abstractions, so swapping back to paid is a binding-type change.

| PRD calls for                   | Raft ships                                                                                                             | Trade-off                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Workers for Platforms           | `PUT /workers/scripts/{name}` per PR + dispatcher 302 to `*.workers.dev` (HMAC-signed `?raft_t=` token + cookie)       | Cap of 100 scripts per account                                   |
| Cloudflare Workflows            | `ProvisionRunner` / `TeardownRunner` Durable Objects with alarm-driven step machines + per-step caching                | Equivalent semantics; bonus: state introspectable from dashboard |
| Cloudflare Access               | Signed `raft_session` cookie (HMAC-SHA256) for the operator dashboard; per-scope HMAC token gates static-site previews | Single-operator demo auth + per-PR token                         |
| R2 for bundles                  | `BUNDLES_KV` (JSON-encoded bundle keyed by `bundle:{install}:{repo}:{headSha}`)                                        | KV value cap 24 MB (well above typical bundle size)              |
| Logpush                         | Workers Logs + per-PR deep-link from dashboard                                                                         | Lose 30-day R2 retention                                         |
| Wildcard custom-domain previews | Path-based dispatcher → 302 → workers.dev                                                                              | Less pretty, still demoable                                      |

---

## Verified

|                                         | Result                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Customer-Worker provision (real PR)     | `state=ready` in **<2s** end-to-end                                        |
| Static-site provision (real PR)         | `state=ready` in **<2s** end-to-end                                        |
| Teardown (real PR closed)               | `state=torn_down` in **<30s**                                              |
| CF resources after teardown             | D1 / KV / Queue / Worker → all `404`                                       |
| Webhook dedup on replayed `delivery_id` | `200` + `dedup:true` (no double-provision)                                 |
| Sticky PR comment                       | Edited in place via embedded HTML marker — never duplicated                |
| Tests                                   | 105 / 105 across 25 files (vitest-pool-workers)                            |
| TypeScript                              | `strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes`, no `any` |
| File / function caps                    | <300 / <40 lines (ESLint-enforced)                                         |

---

## Quick start

```bash
nvm use && corepack enable
pnpm install
pnpm typecheck && pnpm test     # 105/105
pnpm --filter @raft/control dev # http://localhost:8787
```

## Deploy to your own Cloudflare account

See [`CONFIG_CHECKLIST.md`](./CONFIG_CHECKLIST.md) for the full setup. Short version:

```bash
./infra/scripts/bootstrap.sh                                      # create D1 + KV + Queues
pnpm --filter @raft/control exec wrangler d1 migrations apply raft-meta --remote
for s in SESSION_SIGNING_KEY GITHUB_WEBHOOK_SECRET GITHUB_APP_PRIVATE_KEY \
         INTERNAL_DISPATCH_SECRET CF_API_TOKEN; do
  pnpm --filter @raft/control exec wrangler secret put $s
done
pnpm --filter @raft/control run deploy
pnpm --filter @raft/dispatcher run deploy
pnpm --filter @raft/tail run deploy
```

## Operator access

The dashboard is gated by a signed-cookie session. Sign in at `/login` with:

- **Operator email** — any string (audit-logged on every action)
- **Session key** — must match the `SESSION_SIGNING_KEY` secret

The cookie is HMAC-signed, `Secure; HttpOnly; SameSite=Lax`, 7-day TTL. Rotate by uploading a new secret and re-deploying — existing sessions invalidate immediately. Production swaps this for Cloudflare Access (one route handler change).

---

## Repository layout

```
apps/
  control/          raft-control Worker (the brain)
    src/
      do/           Durable Object classes
      lib/          GitHub client, CF client, static-site synth, crypto, logging
      middleware/   auth, rate limiting, request id
      queue/        raft-events consumer
      routes/       Hono route handlers (api, dashboard-api, auth, webhooks)
      runner/       provision/ + teardown/ step machines
      scheduled/    daily cron sweep + alerting
    migrations/     D1 schemas
    tests/          unit + integration (vitest-pool-workers)
  dispatcher/       raft-dispatcher Worker (path-based router)
  tail/             raft-tail Worker (Tail consumer)
  dashboard/        CRA + craco SPA, served by raft-control via Static Assets
packages/
  shared-types/     Result<T,E>, ApiOk/ApiErr, error codes
  tsconfig/         shared TypeScript configs
  eslint-config/    shared ESLint flat config (file/function caps + no-any)
infra/scripts/      bootstrap script (idempotent CF resource creation)
```

---

## Future scope

The free-tier substitutions remain on the production roadmap; each is a binding-type change away.

### Near-term (unblocks bigger customers)

- **Workers for Platforms** — replace `PUT /workers/scripts/{name}` with a dispatch-namespace upload. Removes the 100-scripts-per-account ceiling and unlocks untrusted-mode isolation for OSS contributor PRs.
- **Cloudflare Workflows** — port the two `Runner` DOs to Workflows when the product GAs. The step-cursor + per-step-cache abstraction was designed to make this a one-file swap.
- **R2 for bundles** — move `BUNDLES_KV` blobs to R2; cache base-D1 exports there too so repeated forks within the same SHA don't re-export.

### Medium-term (production-grade auth & multi-tenancy)

- **Cloudflare Access SSO** for the operator dashboard, replacing the signed-cookie demo auth.
- **Per-installation Cloudflare API tokens.** Today every install shares one operator's CF token; production demands customer-scoped tokens stored in Workers Secrets per install.
- **Wildcard custom-domain previews** via Total TLS — `pr-123.preview.customer.com` instead of `*.workers.dev` paths.

### Long-term (product completeness)

- **Containers-based builder** so customers don't need to add `.github/workflows/raft-bundle.yml` themselves. Raft would clone the repo, run their build, and upload the bundle from inside its own Container.
- **Logpush + R2 retention** for the operator log viewer once the customer is on a paid CF plan.
- **Smart base-DB seeding** — let customers point at a tagged D1 snapshot (or a SQL dump in R2) as the per-PR seed instead of always forking the latest base.
- **GitHub Checks API integration** — fail the PR check if the preview HTTP probe is not 200, so reviewers don't waste time clicking dead links.

## License

Portfolio submission. All rights reserved.
