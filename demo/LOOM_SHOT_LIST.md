# Raft demo — 2-minute Loom shot list

Audience: Cloudflare reviewer evaluating an infra-engineer candidate.
Goal: prove the system works end-to-end on the free tier in under 120 seconds.

## Prep (off-screen)

1. `pnpm install && pnpm typecheck && pnpm --filter @raft/control test` → 80+ green tests visible.
2. `pnpm --filter @raft/control dev` running on :8787; `pnpm --filter @raft/dispatcher dev` on :8788.
3. Open three browser tabs: `localhost:8787/login`, terminal, this README.

## On-screen narration (target: ~120s)

| t | Scene | Talk track |
|---|---|---|
| 0:00 | README front page (mermaid diagram) | "Raft. Per-PR preview environments. Cloudflare-only. Free tier." |
| 0:10 | `pnpm --filter @raft/control test` output | "Eighty-something tests, all green. Includes the full alarm-driven provision and teardown chains." |
| 0:25 | Browser → /login, paste shared key | "Sign in with the shared session key." |
| 0:30 | Dashboard `/` (empty installations) | "Empty state. Now I'll simulate a GitHub PR webhook." |
| 0:35 | Terminal: `./demo/simulate.sh` | "This signs an HMAC pull_request.opened webhook, posts it, then polls until ready." |
| 0:45 | Dashboard auto-refresh shows install + PR row | "Watch — installation appears, PR enters provisioning, walks the alarm chain to ready in under 5 seconds." |
| 1:00 | Click into PR detail | "PR detail page: state machine, resource handles (D1 UUID, KV ID, Queue, script name, hostname), live action buttons." |
| 1:15 | Browser → dispatcher URL `/pr-42--customer-app/visit` | "The dispatcher Worker forwards path-prefixed traffic to the per-PR user worker. Each visit increments KV, isolated to this PR." |
| 1:30 | Click Force Teardown | "One click destroys every resource. The TeardownRunner DO walks 9 alarm-driven steps, idempotent on replay." |
| 1:45 | Dashboard shows torn_down | "PR env destroyed. ROUTES KV cleared. Audit trail recorded." |
| 1:55 | README scroll to "Why each Cloudflare product is here" + "Free-tier substitutions" | "Free-tier with documented substitutions for WfP and Workflows. Production swap is a binding-type change." |
| 2:00 | Cut |  |

## Backup if anything goes wrong

- Tests fail → cut to recorded screenshot of `pnpm test` green run.
- Dispatcher 502 → use the direct `*.workers.dev` URL of the user worker.
- Webhook rejected → check `GITHUB_WEBHOOK_SECRET` matches `.dev.vars`.
