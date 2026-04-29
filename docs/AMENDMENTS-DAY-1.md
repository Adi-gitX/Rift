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
