# PRD Amendments — Day 1

These amendments fix bugs and under-specifications I caught while reading
[`rift_PRD.md`](../rift_PRD.md) end-to-end. They are reflected in the v1
implementation and should be folded into the PRD before v2 design begins.

---

## A1 — DurableObjectNamespace has no list-by-prefix API
**Affected**: PRD §10 step 7 ("evict-do-shard").

The PRD assumed `env.{CLASS}.list({ prefix: 'pr-{n}:' })` exists for SQLite-backed
DOs. It does not. The DO storage API exposes `list()` per-instance, but the
namespace binding cannot enumerate instances by name prefix.

**Resolution**: Maintain an explicit DO-id index inside the PrEnvironment DO.
Every time the customer's wrapper module creates a sharded DO instance, the
wrapper records the name in a Set in PrEnvironment storage. Teardown
iterates that Set and POSTs `__raft_destroy__` to each.

The contract is documented in the `@raft/do-cleanup` helper package; customers
opt in by extending `RaftDurableObject` which handles registration automatically.

---

## A2 — Bundle rewriter must use wrapper-binding codegen, not prototype monkey-patching
**Affected**: PRD §9.6.

The PRD proposed monkey-patching `DurableObjectNamespace.prototype.idFromName`.
Workers bindings are host-defined objects whose prototypes may not be mutable
from user code, and even where it works, post-bundle injection is fragile.

**Resolution**: At bundle-rewrite time, for every DO class listed in
`do_classes_to_shard`, emit a wrapper module that re-exports a proxied
namespace whose `idFromName`/`getByName` transparently prepend `pr-{n}:`.
The customer's bundle imports the wrapper instead of using the raw binding
directly. Treat this as the canonical pattern.

The first bundle-rewriter unit test exercises this end-to-end with a
fixture wrangler.jsonc covering D1 + KV + Queue + 2 DO classes.

---

## A3 — D1 import flow is init → upload → ingest → poll, not chunked
**Affected**: PRD §9.5.

The PRD described a chunked POST flow (5 MB max per request).

**Resolution**: The actual D1 import flow is:
```
POST /database/{id}/import { action: 'init', etag }
  → returns { upload_url, filename }
PUT  upload_url with raw SQL bytes
POST /database/{id}/import { action: 'ingest', etag, filename }
POST /database/{id}/import { action: 'poll', current_bookmark }
  → poll until status === 'complete'
```

There is no per-request 5MB cap on the SQL itself; the cap is on individual
API request bodies, which is why uploads go through a signed URL.

`apps/control/src/lib/cloudflare/d1.ts` implements the four-step flow.

---

## A4 — Three-label hostnames don't fit Universal SSL
**Affected**: PRD §9.8 + §14.

The PRD specified `pr-<n>.<repo-slug>.preview.<base>` (three labels deep
under `preview.<base>`). Cloudflare Universal SSL only covers two-level
wildcards on the free tier; this would require Advanced Certificate Manager.

**Resolution**: Flatten to `pr-<n>--<repo-slug>.preview.<base>` (two labels,
fits Universal SSL). The `--` separator is RFC-valid and visually distinct.

For the free-tier submission, even two-label custom-domain wildcards aren't
available, so we further fall back to a path-based dispatcher URL
(`raft-dispatcher.<your>.workers.dev/pr-N--repo/...`).

---

## A5 — Add a `raft-tail` Worker
**Affected**: PRD §7.3 + §17.

The PRD said "LogTail receives Tail Worker output via a Queue", but Tail
Workers receive trace events directly — they don't natively publish to Queues.

**Resolution**: Add `raft-tail` as a third deployable Worker. It is bound as
`tail_consumers` on every WfP (or v1: directly-uploaded) user worker; its
job is to forward trace events to a new `raft-tail-events` Queue, which the
LogTail DO consumes via `raft-control`'s queue handler.

Added to the resource inventory (§4) and the bootstrap script.

---

## A6 — Per-repo upload token spec
**Affected**: PRD §9.4.

The PRD referenced "a per-repo upload token" without specifying minting,
storage, verification, or rotation.

**Resolution**:
- **Minted** at install time and on rotation: 32 bytes from `crypto.getRandomValues`,
  base64url-encoded, prefixed `raft_ut_`.
- **Stored** hashed (SHA-256, base64url) in `repos.upload_token_hash`;
  plaintext shown to user once on the install confirmation page and surfaced
  in the GH Action setup snippet.
- **Verified** with constant-time hash comparison on every
  `POST /api/v1/bundles/upload`.
- **Rotated** via `POST /api/v1/repos/:repoId/rotate-upload-token`, which
  regenerates the token and invalidates the old hash.
- Adds `upload_token_hash TEXT NOT NULL` to the `repos` table in migration `0001_init.sql`.

---

## A7 — v1 does NOT run customer builds; the customer's GitHub Action does
**Affected**: PRD §3.4 (contradicted §9.4).

The PRD §3.4 sentence about "Pranch reads the customer's repo at the PR's
head SHA, runs `wrangler deploy --dry-run` inside a Containers-backed builder"
contradicts §9.4 which scopes that work to v2.

**Resolution**: §9.4 is canonical. v1 does NOT run customer builds inside
Raft. The customer's GitHub Action (which we provide) runs
`wrangler deploy --dry-run --outdir=dist` in the customer's CI and POSTs the
resulting bundle to Raft's `POST /api/v1/bundles/upload` endpoint with their
upload token. v2 will introduce Cloudflare Containers-based builders.

---

## A8 — Workers Logs and Logpush coexist with distinct roles
**Affected**: PRD §17.

The PRD conflated Workers Logs (the in-dashboard log viewer enabled by
`observability.enabled: true`) and Logpush (which ships logs to an R2/S3
destination via REST API).

**Resolution**: Use both, with clear roles:
- **`observability.enabled: true`** gives the native Workers log viewer.
  Use this for live debugging during incident response. No code needed.
- **Logpush jobs** (paid tier feature in some regions; free for some
  Workers Logs destinations) ship structured logs to an R2 bucket for
  30-day retention and offline analysis. T12.4 configures these via REST API.
- **Analytics Engine writes** are application-level events (state transitions,
  durations) — separate from Workers Logs / Logpush. All three coexist.

For the free-tier submission, only `observability.enabled` and Analytics
Engine are used; Logpush is documented as a follow-up.

---

## A9 — Convention for Result vs throw
**Affected**: PRD §20 ("Errors are values"), conflicts with Workflow step semantics.

Workflow `step.do` is exception-based (it retries on throw). Returning
`Result<T,E>` everywhere would defeat the retry mechanism.

**Resolution** (now applied throughout the codebase):
- **Inside Workflow / DO alarm steps**: throw on retryable failures so the
  runner handles the retry loop; throw a `NonRetryableError` (subclass of
  `CodedError`) for poison-pill conditions.
- **At HTTP boundaries** (routes, RPC handlers): return `Result<T, CodedError>`;
  only throw for programmer errors that should never reach production.
- **In `lib/*` helpers**: prefer `Result`; throw only when the caller cannot
  meaningfully recover.

---

*End of Day-1 amendments. Each is implemented in the v1 codebase and
referenced in inline `// PRD amendment AX` comments.*

---

# Day-2 changes (v0.2.0)

These changes ship the customer-Worker bundle path (PRD §9.4 Track A) and
add several production-readiness fixes. Every change is in code; this
section is the reference for what diverged from the Day-1 design.

## D1 — Customer-Worker bundle ingestion (Track A)
**Affected**: PRD §9.4 (build-bundle), §9.7 (upload-to-wfp), §9.9 (sync flow).

The PRD called for the customer's GH Action to POST a zip to a
Raft-controlled URL, with the control Worker storing the zip in R2.
Implementation:

- Switched from zip to JSON payload to avoid a zip-parser dependency
  inside the worker. Customer's GH Action runs a tiny Node script that
  base64-encodes each module from `wrangler deploy --dry-run --outdir=dist`
  and POSTs `{wrangler, modules: [{name, content_b64, type}]}` to
  `/api/v1/bundles/upload`.
- Storage moved from R2 to `BUNDLES_KV` keyed by `bundle:{installation}:{repo}:{headSha}`.
  Cap is 24 MB (KV value limit); typical bundles are well under 1 MB.
- New `await-bundle` step inserted into `STEP_ORDER` between `load-config`
  and `provision-resources`. Polls `BUNDLES_KV` every 2s up to a 5-min
  timeout. No-op for `static` and `fallback` modes — returns immediately.
- `loadConfig` detection precedence: `wrangler.{jsonc,json,toml}` →
  `customer-bundle`; else `index.html` under root/public/dist/build/site
  → `static-synth`; else `fallback`.
- `rewriteBundle` now consumes the customer's modules from KV and threads
  the customer's `main_module` through to `uploadScript`. (Bug found
  during verification: `uploadScript` was reading `config.wrangler.main_module`
  which was always `worker.js`, while the customer's bundle had
  `index.js`. CF returned 400 "No such module: worker.js" until the fix.)

## D2 — D1 base-DB fork (PRD §9.3, fork-base-db)
**Affected**: PRD §9.3 (prepare-base-export), §9.5 (provision-resources).

The PRD bundled the export+import flow into provision-resources. Split
into a dedicated `fork-base-db` step (between `provision-resources` and
`rewrite-bundle`) so failures degrade cleanly rather than failing the
provision. Source preference:

1. `repo.baseD1Id` (per-repo configuration; not yet exposed via UI)
2. `RAFT_DEMO_BASE_D1_ID` env (demo-mode default)
3. Skip → empty per-PR DB

Step is **NOT** cleared on `synchronize`/redeploy: re-importing on top of
an already-seeded DB would duplicate rows / conflict on schema migrations.
Treated as one-shot per PR-env, like resource creation.

## D3 — `provision-resources` made list-then-create idempotent
**Affected**: PRD §9.5.

CF's create endpoints for D1 / KV / Queue all reject "name already
exists" with different status codes (D1: 400+7502, KV: 400+10014, Queue:
409+11009). On redeploy / replay against the same PR, the deterministic
resource names collide. Resolution: list-by-name first via `client.raw`,
construct the result from the existing entry; only POST create when
nothing matches. Result type is constructed inline to avoid the schema-
strictness issues that bit the original `findOrCreate` attempt.

## D4 — Per-step start/finish timestamps
**Affected**: PRD §7 (DO designs).

`ProvisionRunnerState` now carries `stepTimings: Partial<Record<step,
{startedAt, finishedAt}>>`. `runStep` stamps `startedAt` on first attempt
(retries reuse it so wall-clock is honest), then `finishedAt` after the
result persists. Dashboard latency chart reads from these directly;
falls back to "approximate equal slices" only for legacy snapshots.

## D5 — Synchronize race + step-cache reset
**Affected**: PRD §7.2.

DO runtime serialises everything, so the race is just stale cached step
results. `start()` now clears `step:{load-config, await-bundle,
rewrite-bundle, upload-script, route-and-comment}` and resets
`stepTimings: {}` on every fresh start. KEEPS `step:provision-resources`
and `step:fork-base-db` (re-running them would 4xx or duplicate data).

## D6 — Webhook deduplication on `delivery_id`
**Affected**: PRD §8.

GitHub retries deliveries on timeout. Without dedup, `pull_request.opened`
could double-provision. Added a 24h KV cache on `webhook-dedup:{deliveryId}`.
Replays return 200 + `{accepted: 0, dedup: true}` and never re-enqueue.
Stash happens before enqueue so a flapping retry never sees a window.

## D7 — Per-repo quota guard
**Affected**: new (PRD didn't enforce this).

`RepoCoordinator.beginProvision` checks live D1 + Queue counts (which cap
at 10 each on free tier) and refuses to create a fresh `pending` env
that would push past 9/10. Emits `pr_env.quota_blocked` audit row.
Synchronize on existing envs is allowed (already counted).

## D8 — Per-scope HMAC token gates static-synth previews
**Affected**: PRD §12 (security model).

The PRD assumed Cloudflare Access for preview gating (paid). Free-tier
substitute: the dispatcher computes
`base64url-truncated HMAC-SHA256("raft-preview:{scope}",
INTERNAL_DISPATCH_SECRET)` and appends it to the 302 as `?raft_t=` plus
`Set-Cookie: raft_t=...`. The synthesised static worker checks the
query param OR the cookie; rejects 401 otherwise. Bare `*.workers.dev`
URLs stop being publicly walkable.

For customer-bundle mode this is opt-in (the customer's worker would
need to verify the token); the bundle-rewriter does not auto-inject.

## D9 — Operator alerting from cron
**Affected**: PRD §17.

New `runAlertChecks` runs alongside the daily sweep. POSTs to
`RAFT_ALERT_WEBHOOK` (Slack-incoming-webhook compatible) when:

- Any free-tier slot exceeds 80% (workers/D1/KV/queues; control-plane
  overhead included)
- Any PR env has been in `pending`/`provisioning`/`updating` with
  `last_activity_at` older than 5 min (stuck runner)

No-op if the env var is unset.

## D10 — Removed: AI bundle review (was prototyped, dropped before publish)
**Affected**: was new (PRD didn't include).

A prototype attached an LLM-generated 3-bullet review to each sticky PR
comment, gated by an optional API key. Removed before publish to keep
the surface area focused on the deterministic provisioning + lifecycle
machinery. The PR comment now ships preview URL, bundle source chip,
and a live HTTP probe — no AI.

---

## Deferred to v1.5 (honest)

- **Per-installation Cloudflare API tokens**: the schema seed exists
  (installations table has fields) but runtime wiring is not done.
  Demo uses a single shared `CF_API_TOKEN`. Production multi-tenancy
  needs encrypted storage in D1 (free path) or Secrets Store (paid).
- **Real log streaming**: `LogTail` DO + `raft-tail` Worker are wired,
  but binding the tail consumer to per-PR scripts requires Workers Paid.
  Workaround in PR detail: deep-link to the script's Workers Logs page
  in the CF dashboard.
- **`fork-base-db` happy-path unit test**: works in production; only the
  degrade path is covered by integration tests. A green-path test would
  need to mock the full export → init → upload → ingest → poll flow
  inside vitest-pool-workers.

*End of Day-2 amendments.*
