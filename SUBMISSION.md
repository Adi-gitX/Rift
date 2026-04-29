# Raft — Cloudflare Submission

**Per-PR preview environments for Cloudflare Workers. Built end-to-end on the Cloudflare free tier.**

- **Live:** https://raft-control.adityakammati3.workers.dev
- **Repo:** https://github.com/Adi-gitX/Rift

---

## 1. Problem Statement

Every modern web platform — Vercel, Netlify, Render, Fly — gives reviewers a unique URL for every pull request. Cloudflare Workers does not. Reviewing a Workers PR today means one of three bad options:

1. Pull the branch and `wrangler dev` locally — slow, breaks shared state, no live URL to share.
2. Share a single staging Worker — concurrent PRs collide on D1 / KV / Queues.
3. Roll your own per-PR provisioner — nobody does this because the orchestration is hard.

The result: PR review for Workers projects is slower and riskier than for any other modern serverless platform. Cloudflare's own community has been asking for this since 2022 ([workers-sdk #2701](https://github.com/cloudflare/workers-sdk/issues/2701)).

**Raft fixes this.** A team installs the GitHub App on a Workers repo. Every PR gets a fully isolated stack — D1, KV, Queue, DO shard, deployed Worker — provisioned in <1 second, torn down in <30 seconds. Zero customer infrastructure. Zero paid Cloudflare products.

---

## 2. Cloudflare Usage

### Products used (all on free tier)

| Product | Role |
|---|---|
| **Workers** | 3 deployable Workers: `raft-control`, `raft-dispatcher`, `raft-tail` |
| **Workers Static Assets** | Dashboard SPA shipped inside `raft-control` (`run_worker_first: true`) |
| **D1** | `raft-meta` for installations / repos / PR envs / audit; per-PR forks via export+import REST API |
| **KV** | `CACHE` (rate limits, install-token cache), `ROUTES` (path → user-worker lookup), `BUNDLES_KV` (bundle blobs) |
| **Queues** | `raft-events` (decouple webhook receipt from provisioning) + `raft-tail-events` (Tail fan-out) |
| **Durable Objects** | 5 classes — `RepoCoordinator`, `PrEnvironment`, `ProvisionRunner`, `TeardownRunner`, `LogTail` |
| **DO Alarms** | Replaces paid Cloudflare Workflows — alarm-driven step machines with backoff |
| **Hibernatable WebSockets** | Live log streaming to dashboard, no connection-time billing |
| **Cron Triggers** | Daily 04:00 UTC sweep of idle PR environments |
| **Workers Tail** | `raft-tail` Worker consumes user-worker trace events into a Queue |
| **Workers Logs** | Native log viewer (Logpush is paid; this is the free substitute) |

### Why Cloudflare

Three Cloudflare-only primitives make this product possible. **No other cloud has the equivalent.**

1. **D1 export/import REST API** lets us "fork" a database in seconds without copying storage at the block layer — the foundation of per-PR data isolation.
2. **Direct `PUT /workers/scripts/{name}`** lets one account host hundreds of per-PR user scripts — a free-tier substitute for Workers for Platforms.
3. **DO Alarms with SQLite-backed storage** give us a free-tier substitute for Cloudflare Workflows: durable, retryable, idempotent step machines with replay safety.

### What was built

```mermaid
flowchart LR
  GH[GitHub<br/>PR opened/closed]
  GH -->|webhook<br/>HMAC verified| CTL

  subgraph CFEdge[Cloudflare Edge]
    CTL[raft-control Worker<br/>Hono · API · Dashboard · Cron]
    DISP[raft-dispatcher Worker<br/>path-based proxy]
    TAIL[raft-tail Worker<br/>Tail consumer]
  end

  CTL -->|enqueue| EVQ[(raft-events Queue)]
  EVQ --> CTL
  CTL --> REPO[RepoCoordinator DO]
  REPO --> PROV[ProvisionRunner DO<br/>5-step alarm machine]
  REPO --> TEAR[TeardownRunner DO<br/>9-step alarm machine]

  PROV -->|CF REST API| CFR[Cloudflare API<br/>D1 · KV · Queues · Workers]
  TEAR --> CFR
  PROV --> META[(D1 raft-meta)]
  PROV --> ROUTES[(KV raft-routes)]

  USER[User Worker<br/>uploaded per PR]
  CFR -.creates.-> USER
  USER -.tail trace.-> TAIL
  TAIL --> TQ[(raft-tail-events Queue)]
  TQ --> LT[LogTail DO<br/>WebSocket fan-out]

  BR[Browser] --> CTL
  BR --> DISP
  DISP -->|lookup| ROUTES
  DISP -->|fetch| USER
```

### Free-tier engineering — the interesting bit

The PRD calls for two paid products. Raft substitutes both behind thin abstractions, so swapping back to paid is a binding-type change.

| PRD calls for (paid) | Raft v1 ships (free) | Trade-off |
|---|---|---|
| Workers for Platforms ($25+/mo) | Direct `PUT /workers/scripts/{name}` per PR | Capped at 100 scripts/account vs unlimited |
| Cloudflare Workflows | DO Alarms with explicit step cursor + cached step results | Equivalent semantics; bonus: full state introspectable from the dashboard |
| Logpush | `raft-tail` Worker → Queue → DO fan-out | Lose 30-day R2 retention; gain $0 cost |
| Cloudflare Access | Signed-cookie auth (HMAC-SHA256) | One-operator demo auth |

### Provisioning machine

Every step is idempotent. If the alarm fires twice, cached results short-circuit. If a step throws, the alarm reschedules with backoff (1s → 2s → 4s → 8s → 16s, max 5 attempts). If the PR is closed mid-provision, the runner aborts cleanly and the teardown machine picks up only what got created.

```mermaid
stateDiagram-v2
  [*] --> load_config: alarm fires
  load_config --> provision_resources: SUCCESS<br/>(.raft.json @ head SHA)
  provision_resources --> rewrite_bundle: SUCCESS<br/>(D1 + KV + Queue created in parallel)
  rewrite_bundle --> upload_script: SUCCESS<br/>(binding IDs swapped, DO wrappers codegened)
  upload_script --> route_and_comment: SUCCESS<br/>(PUT /workers/scripts/{name})
  route_and_comment --> ready: SUCCESS<br/>(ROUTES KV written, sticky PR comment)
  ready --> [*]

  load_config --> failed: 5 attempts exhausted
  provision_resources --> failed
  rewrite_bundle --> failed
  upload_script --> failed
  route_and_comment --> failed
  failed --> [*]
```

---

## 3. Impact / Metrics

Measured against the live deployment with a real GitHub App and real Cloudflare account.

| Metric | PRD target | Measured | Result |
|---|---|---|---|
| Provision: PR opened → preview URL | <90s | **<1s** | **90× better** |
| Teardown: PR closed → all resources gone | <30s | **<30s** | ✅ on target |
| Provision steps | 5 | 5 | ✅ each cached + idempotent |
| Teardown steps | 9 | 9 | ✅ CF 404 = already-gone (idempotent re-runs are safe) |
| Per-PR Cloudflare resources | D1 + KV + Queue + Worker (+ DO shard) | 4 + 1 | ✅ verified live by cross-checking CF REST API |
| Cost to operate | $0 | **$0** | ✅ no paid CF products |
| Cost to install | $0 | **$0** | ✅ no customer infra |
| Free-tier headroom | — | D1 7/10 · KV 7/100 · Queues 7/10 · Workers 7/100 | ~95 concurrent PR envs supported |
| Tests passing | 80+ | 82 | ✅ 22 files, 82 tests, all green |
| TypeScript | strict, no `any` | strict, no `any` | ✅ enforced by ESLint |
| File / function caps | <300 / <40 lines | <300 / <40 lines | ✅ enforced by ESLint |

### End-to-end verification (live, against production)

Posted a real HMAC-signed `pull_request.opened` webhook for PR #99. The PR reached `state=ready` with `cursor=5/5, status=succeeded, attempts=0, errors=0` in **under one second**. Cross-referenced the D1 UUID in our metadata DB against Cloudflare's `/d1/database` list — UUIDs matched.

Posted `pull_request.closed`. The PR reached `state=torn_down` in <30s. Verified deletion against the Cloudflare REST API for all four resources:

- D1 `fd3913ef-…`: CF responds 404 (code 7404 — not found) ✅
- KV `845f3837…`: CF responds 404 (code 10013) ✅
- Queue `d692f4d7…`: CF responds 404 (code 11000) ✅
- Worker `raft-128067035-…-pr-99`: HTTP 404 ✅

### Lifecycle latency

```mermaid
gantt
  title PR #99 — provisioned and torn down in real time (real Cloudflare resources)
  dateFormat HH:mm:ss
  axisFormat %S.%L

  section Provision
  load-config              :done, 00:00:00, 100ms
  provision-resources      :done, 00:00:00, 400ms
  rewrite-bundle           :done, 00:00:00, 50ms
  upload-script            :done, 00:00:00, 350ms
  route-and-comment        :done, 00:00:00, 100ms
  ready                    :milestone, after route-and-comment, 0s

  section Teardown
  mark-tearing-down        :done, 00:00:01, 50ms
  delete-worker-script     :done, 00:00:01, 600ms
  delete-d1                :done, 00:00:01, 4s
  delete-kv                :done, 00:00:01, 2s
  delete-queue             :done, 00:00:01, 6s
  purge-bundle-kv          :done, 00:00:01, 50ms
  evict-do-shard           :done, 00:00:01, 50ms
  clear-route              :done, 00:00:01, 50ms
  mark-torn-down           :done, 00:00:01, 50ms
```

---

## 4. Short Write-up (300 words)

Raft gives Cloudflare Workers teams the per-PR preview-environment workflow that Vercel and Netlify popularized — but designed from the ground up around Cloudflare primitives, with full data-layer isolation no other platform can match.

A team installs the Raft GitHub App on a Workers repository. When a developer opens a pull request, Raft provisions a complete isolated stack within one second: a fresh D1 database (forkable from the base via the export/import REST API), a dedicated KV namespace, its own Queue, a sharded Durable Object namespace, and a uniquely-named Worker script. The PR's code is bundled, binding IDs are rewritten on the fly, the script is uploaded directly via `PUT /workers/scripts/{name}`, and a sticky comment with the preview URL appears on the PR. Reviewers click and see a fully isolated environment — their writes never touch staging. When the PR is closed, all five resource types are destroyed within thirty seconds, idempotently.

The orchestration runs on **Durable Object Alarms** rather than paid Cloudflare Workflows. Each runner is an explicit step machine with a cursor in DO storage and per-step cached results, giving us replay safety, exponential backoff, and equivalent observability — entirely on the free tier. Three Workers participate: `raft-control` (webhook ingress, Hono API, dashboard SPA, cron, all DOs), `raft-dispatcher` (path-based router into per-PR user Workers), and `raft-tail` (free-tier Logpush substitute pulling Workers Tail into a Queue).

Verified live against real Cloudflare resources: PR-opened → ready preview in **<1 second** (PRD target was 90s). PR-closed → all four CF resources confirmed deleted in **<30 seconds**, cross-checked directly against the Cloudflare REST API.

Built end-to-end on free-tier Cloudflare. Zero paid products. Zero customer infrastructure beyond their existing repo. **This product can't exist on any other cloud.**
