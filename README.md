# Raft — per-PR preview environments for Cloudflare Workers

> A GitHub App that gives every pull request its own fully-isolated Cloudflare stack: D1 database, KV namespace, Queue, Durable Object shard, and deployed Worker — provisioned in **<1 second**, torn down in **<30 seconds**. Built end-to-end on the Cloudflare **free tier**.

- **Live dashboard:** https://raft-control.adityakammati3.workers.dev
- **Submission write-up:** [`SUBMISSION.md`](./SUBMISSION.md)
- **PRD (single source of truth):** [`rift_PRD.md`](./rift_PRD.md)
- **Origin:** [workers-sdk #2701 — "Per-PR preview deployments"](https://github.com/cloudflare/workers-sdk/issues/2701)

---

## Why this is a Cloudflare-only problem

Three Cloudflare primitives that landed in 2024–2026 made this practical for the first time. **No other cloud has the equivalent of any of them.**

1. **D1 export / import REST API** — fork a database in seconds without copying storage at the block layer. The basis of per-PR data isolation.
2. **Direct `PUT /workers/scripts/{name}`** — host hundreds of per-PR user scripts in one account. Free-tier substitute for Workers for Platforms.
3. **DO Alarms with SQLite-backed storage** — durable, retryable, idempotent step machines. Free-tier substitute for Cloudflare Workflows.

---

## Architecture at a glance

```mermaid
flowchart LR
  GH[GitHub<br/>PR opened/closed/sync]

  subgraph Edge[Cloudflare Edge]
    direction TB
    CTL[raft-control<br/>Hono · API · Dashboard · Cron]
    DISP[raft-dispatcher<br/>path-based proxy]
    TAIL[raft-tail<br/>Tail consumer]
  end

  subgraph DOs[Durable Objects in raft-control]
    direction TB
    REPO[RepoCoordinator<br/>per installation, repo]
    PRENV[PrEnvironment<br/>per PR · single-writer]
    PROV[ProvisionRunner<br/>5-step alarm machine]
    TEAR[TeardownRunner<br/>9-step alarm machine]
    LT[LogTail<br/>WS fan-out + ring buffer]
  end

  subgraph Storage[Storage]
    direction TB
    META[(D1 raft-meta)]
    CACHE[(KV CACHE)]
    ROUTES[(KV ROUTES)]
    BUNDLES[(KV BUNDLES)]
    EVQ[(Queue raft-events)]
    TQ[(Queue raft-tail-events)]
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
  USER -.tail traces.-> TAIL
  TAIL --> TQ
  TQ --> LT

  BR[Browser] --> CTL
  BR --> DISP
  DISP -->|lookup| ROUTES
  DISP -->|fetch| USER

  CRON([Cron 04:00 UTC]) --> CTL
```

### Three deployable Workers, one shared metadata D1

| Worker | URL | Job |
|---|---|---|
| `raft-control` | `<your>.workers.dev` | webhooks · API · dashboard · cron · queue consumers · all DOs |
| `raft-dispatcher` | `raft-dispatcher.<your>.workers.dev` | path-based proxy `/<scope>/...` → user worker |
| `raft-tail` | `raft-tail.<your>.workers.dev` | Tail consumer bound to every per-PR user worker |

---

## Why each Cloudflare product is here

| Product | Used for | Why it's the right tool |
|---|---|---|
| **Workers** (free) | All three control-plane workers | The runtime |
| **Workers Static Assets** | Dashboard SPA inside `raft-control` | Same Worker handles API + UI; `run_worker_first: true` |
| **Durable Objects** (SQLite) | `RepoCoordinator`, `PrEnvironment`, `ProvisionRunner`, `TeardownRunner`, `LogTail` | Single-writer state machines + alarm-driven retry loops without paid Workflows |
| **D1** (free, 10 dbs / 5 GB) | `raft-meta`: installations / repos / PR envs / audit | Strongly-consistent metadata; per-PR forks via export+import REST API |
| **KV** (free) | `CACHE` (rate limits, install tokens), `ROUTES` (scope→script), `BUNDLES_KV` (bundle blobs) | Eventual-consistency lookups + fast reads on the dispatcher hot path |
| **Queues** (free, 1M ops/mo) | `raft-events` (webhooks), `raft-tail-events` (Tail fan-out) | Decouples webhook receipt (<200ms) from provisioning |
| **Cron Triggers** | Daily stale-env GC at 04:00 UTC | Hands-off cleanup for forgotten PRs |
| **Workers Tail** | Forward user-worker trace events into a Queue | Feeds the `LogTail` DO for live dashboard logs |
| **Hibernatable WebSockets** | Dashboard live log streaming | Tens of thousands of dashboard tabs without connection-time billing |
| **Workers Logs** | Native log viewer | Free; Logpush is paid |

---

## Provision lifecycle

5 idempotent steps, alarm-driven, exponential backoff `1 → 2 → 4 → 8 → 16s`, max 5 attempts per step. Every step caches its result in DO storage so replays short-circuit safely.

```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub
  participant CTL as raft-control
  participant Q as raft-events Queue
  participant REPO as RepoCoordinator DO
  participant PROV as ProvisionRunner DO
  participant CF as Cloudflare REST API
  participant ROUTES as ROUTES KV

  GH->>CTL: pull_request.opened (HMAC signed)
  CTL->>CTL: verify signature, rate limit
  CTL->>Q: enqueue
  CTL-->>GH: 202 Accepted (<200ms)

  Q->>CTL: dispatch
  CTL->>REPO: dispatch(prEvent)
  REPO->>PROV: kickoff(prEnvId)

  loop alarm-driven step machine
    Note over PROV: 1. load-config (.raft.json @ head SHA)
    Note over PROV: 2. provision-resources
    PROV->>CF: POST /d1/database
    PROV->>CF: POST /storage/kv/namespaces
    PROV->>CF: POST /queues
    Note over PROV: 3. rewrite-bundle (binding IDs + DO wrappers)
    Note over PROV: 4. upload-script
    PROV->>CF: PUT /workers/scripts/{name}
    Note over PROV: 5. route-and-comment
    PROV->>ROUTES: write scope → script
    PROV->>GH: sticky PR comment with preview URL
  end

  PROV->>REPO: state = ready
```

## Teardown lifecycle

9 idempotent steps. CF returning 404 = already gone = success.

```mermaid
stateDiagram-v2
  [*] --> mark_tearing_down
  mark_tearing_down --> delete_worker_script
  delete_worker_script --> delete_d1
  delete_d1 --> delete_kv
  delete_kv --> delete_queue
  delete_queue --> purge_bundle_kv
  purge_bundle_kv --> evict_do_shard
  evict_do_shard --> clear_route
  clear_route --> mark_torn_down
  mark_torn_down --> [*]
```

---

## Free-tier substitutions vs the production PRD

The PRD calls for **Workers for Platforms** and **Cloudflare Workflows** — both paid (>$25/mo). Raft v1 ships entirely on the free tier. Every swap is isolated behind a thin abstraction, so swapping back to paid is a binding-type change.

| PRD calls for (paid) | Raft v1 ships (free) | Trade-off |
|---|---|---|
| Workers for Platforms dispatch namespace | `PUT /workers/scripts/{name}` + `*.workers.dev` URL with shared-secret header | Capped at **100 scripts/account** (~95 concurrent PR envs) |
| Cloudflare Workflows | `ProvisionRunner` / `TeardownRunner` DOs with alarm-driven step machines | Equivalent: durable, retryable, idempotent. Bonus: state introspectable from dashboard |
| Cloudflare Access | Signed `raft_session` cookie (HMAC-SHA256) | One-operator demo auth |
| R2 bundle storage | `BUNDLES_KV` (KV blob, base64) | Bundles capped at 24 MB (KV value limit) |
| Logpush | Workers Logs (native viewer) + Analytics Engine | Lose 30-day R2 retention; gain $0 cost |
| Wildcard custom-domain previews (`pr-N--repo.preview.<base>`) | Path-based dispatcher (`raft-dispatcher.<base>/pr-N--repo/...`) | Less pretty; still demoable |

---

## Live verification

Posted real HMAC-signed webhooks against production:

| Event | Result |
|---|---|
| `pull_request.opened` for PR #99 | `state=ready, cursor=5/5, attempts=0, errors=0` in **<1s** |
| Cross-check D1 UUID in CF `/d1/database` list | UUID matches our metadata DB ✅ (real resource) |
| `pull_request.closed` for PR #99 | `state=torn_down` in **<30s** |
| Verify D1 / KV / Queue / Worker against CF REST API after teardown | All four return `404` ✅ |

---

## PRD amendments applied

The PRD had 9 bugs / under-specs caught during design. All are fixed; see [`docs/AMENDMENTS-DAY-1.md`](./docs/AMENDMENTS-DAY-1.md). Highlights:

- **A1**: `DurableObjectNamespace` has no list-by-prefix → `PrEnvironment` DO maintains an explicit `Set` of shard names; teardown enumerates that.
- **A2**: Bundle rewriter emits per-DO-class **wrapper modules** instead of monkey-patching the namespace binding.
- **A3**: D1 import is `init → upload to signed URL → ingest → poll`, not chunked POST.
- **A4**: Hostname scheme flattened to `pr-{n}--{repo}.preview.{base}` (two labels) to fit Universal SSL.
- **A5**: `raft-tail` Worker added; Tail events flow through `raft-tail-events` Queue.
- **A6**: Per-repo upload tokens are 32 random bytes, base64url, prefixed `raft_ut_`, hashed (SHA-256) in `repos.upload_token_hash`.
- **A9**: Throw inside DO alarm steps for retry; `Result<T,E>` at HTTP boundaries.

---

## Repository layout

```
apps/
  control/          # raft-control Worker — the brain
    src/
      index.ts                          # Hono entry, queue/scheduled handlers, DO exports
      env.ts                            # typed Env mirroring wrangler.jsonc
      lib/
        cloudflare/                     # CF REST client (D1, KV, Queues, R2, Workers)
        bundle-rewriter/                # rewrites wrangler.jsonc + emits DO wrappers
        crypto/                         # HMAC, JWT (RS256), PEM, hex
        auth/                           # signed cookies, upload tokens, rate limit
        github/                         # webhook verify, schemas, install-token cache
        db/                             # typed CRUD over Env['DB']
      do/
        repo-coordinator.ts             # one DO per (installation, repo)
        pr-environment.ts               # one DO per PR; single-writer for state
        provision-runner.ts             # alarm-driven 5-step provisioning machine
        teardown-runner.ts              # alarm-driven 9-step destruction machine
        log-tail.ts                     # hibernatable-WS log fan-out
      runner/{provision,teardown}/      # step definitions + state types
      routes/{github,api,auth,dashboard}.ts
      queue/{consumer,tail-consumer}.ts
      scheduled/sweep.ts                # daily GC of stale envs
      middleware/                       # request-id, logger, error → ApiErr, require-auth
    migrations/                         # 0001_init.sql, 0002_audit_log.sql, 0003_billing.sql
    tests/                              # 80+ vitest-pool-workers tests
  dispatcher/       # raft-dispatcher Worker — path-based proxy
  tail/             # raft-tail Worker — Tail consumer
  dashboard/        # CRA + craco SPA, served by raft-control via Static Assets
packages/
  shared-types/     # Result<T,E>, ApiOk/ApiErr, error codes, NonRetryableError
  tsconfig/         # shared TS configs
  eslint-config/    # shared ESLint flat config
infra/scripts/bootstrap.sh   # idempotent CF resource creation
demo/                        # fixture customer worker + simulation script
```

---

## Local development

```bash
nvm use                              # Node 22
corepack enable                      # pnpm via corepack
pnpm install
pnpm typecheck
pnpm lint
pnpm --filter @raft/control test     # 80+ tests, all green

# Boot the control worker locally
cp apps/control/.dev.vars.example apps/control/.dev.vars
# (fill placeholder secrets)
pnpm --filter @raft/control dev
curl http://localhost:8787/healthz
open http://localhost:8787/login     # use SESSION_SIGNING_KEY as the shared key
```

## Deploy to your Cloudflare account

See [`CONFIG_CHECKLIST.md`](./CONFIG_CHECKLIST.md) for the full step-by-step.

```bash
./infra/scripts/bootstrap.sh                         # creates D1, KV, Queues
# paste IDs into apps/control/wrangler.jsonc
pnpm --filter @raft/control exec wrangler d1 migrations apply raft-meta --remote
pnpm --filter @raft/control exec wrangler secret put SESSION_SIGNING_KEY
pnpm --filter @raft/control exec wrangler secret put GITHUB_WEBHOOK_SECRET
pnpm --filter @raft/control exec wrangler secret put GITHUB_APP_PRIVATE_KEY
pnpm --filter @raft/control exec wrangler secret put INTERNAL_DISPATCH_SECRET
pnpm --filter @raft/control exec wrangler secret put CF_API_TOKEN
pnpm --filter @raft/control deploy
pnpm --filter @raft/dispatcher deploy
pnpm --filter @raft/tail deploy
```

## Tests

```
Test Files  22 passed (22)
Tests       82 passed (82)
```

Coverage:

- Repo layer (D1 CRUD): round-trip, idempotency, state-machine transitions, FK cascades.
- Crypto: HMAC verify (timing-safe), JWT signing, ULID monotonicity.
- Cloudflare API client: happy path, 429/5xx retry with backoff, 4xx no-retry, envelope mismatch, FormData multipart.
- Bundle rewriter: D1+KV+Queue binding swap, DO wrapper codegen for two classes, plain_text injection.
- ProvisionRunner DO: full 5-step alarm chain to `ready`, ROUTES KV written, idempotency on replay.
- TeardownRunner DO: full 9-step destruction to `torn_down`, ROUTES KV cleared, idempotent re-run.
- Webhook integration: HMAC reject + accept → queue → consumer → DO transitions → audit rows.
- API integration: signed-cookie auth (401 vs 200), bundle upload (good vs bad token), manual teardown returns 202.
- Logger: structured JSON, token redaction (40+ chars), UUID preservation, per-level filtering.

---

## Coding standards (PRD §20, enforced by ESLint + tsc)

- TypeScript `strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes`
- No `any`. No default exports (one documented exception: the Workers entrypoint).
- Files <300 lines, functions <40 lines.
- Zod at every external boundary.
- Errors as values at HTTP boundaries; throw inside DO alarm steps so retries fire.
- Structured logger (token-redacting) — no `console.log` outside the logger.
- Idempotency keys on every external mutation (step-name in DO storage; `Idempotency-Key` headers where the API supports them).

---

## Future work (production path back from the free-tier substitutions)

- **Workers for Platforms** for true untrusted-mode user-worker isolation, no `*.workers.dev` URL exposure, and unbounded script count.
- **Cloudflare Workflows** instead of DO alarm runners (the runners become near-trivial wrappers — same step interfaces, same idempotency story).
- **Cloudflare Access** SSO instead of shared-cookie auth.
- **R2** for bundles + base-D1 export caching + log archival via Logpush.
- **Custom domain with wildcard previews** (`pr-N--repo.preview.raft.dev`) and Total TLS.
- **Per-installation Cloudflare API tokens** in Secrets Store, replacing the single shared `CF_API_TOKEN`.
- **Containers-based builder** instead of customer-side GH Action POSTing the bundle.

The architecture stays the same; each item above swaps a binding or replaces a thin layer.

## License

This is a portfolio submission. All rights reserved.
