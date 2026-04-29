---
title: "Raft"
subtitle: "Per-PR Preview Environments for Cloudflare Workers"
author: "Adithya Kammati"
---

# Raft

**Per-PR Preview Environments for Cloudflare Workers**

Built end-to-end on the Cloudflare free tier · [raft-control.adityakammati3.workers.dev](https://raft-control.adityakammati3.workers.dev) · [github.com/Adi-gitX/Rift](https://github.com/Adi-gitX/Rift)

---

## The problem

Every modern web platform — Vercel, Netlify, Render, Fly — gives reviewers a unique URL for every pull request. Cloudflare Workers does not. Reviewing a Workers PR today means cloning the branch and running `wrangler dev` locally, sharing one staging Worker that collides with every other open PR, or rolling a bespoke per-PR provisioner — which nobody does, because the orchestration is genuinely hard. The Cloudflare community has been asking for this since 2022 ([workers-sdk #2701](https://github.com/cloudflare/workers-sdk/issues/2701)).

## What Raft does

Install the Raft GitHub App on a Cloudflare Workers repository. When a developer opens a pull request, Raft provisions a fully isolated stack within **one second**: a fresh D1 database (forkable from the base via the export/import REST API), a dedicated KV namespace, its own Queue, a sharded Durable Object namespace, and a uniquely-named Worker script. The PR's code is bundled, binding IDs are rewritten on the fly, the script is uploaded directly via `PUT /workers/scripts/{name}`, and a sticky comment with the preview URL appears on the PR. Reviewers click and see a fully isolated environment — their writes never touch staging. When the PR is closed, all five resource types are destroyed within **thirty seconds**, idempotently.

## The Cloudflare-native engineering

The orchestration runs on **Durable Object Alarms** rather than the paid Cloudflare Workflows product. Each runner is an explicit step machine with a cursor in DO storage and per-step cached results, giving us replay safety, exponential backoff, and equivalent observability — entirely on the free tier. Three Workers participate: `raft-control` (webhook ingress, Hono API, dashboard SPA, cron, all DOs), `raft-dispatcher` (path-based router into per-PR user Workers), and `raft-tail` (a free-tier Logpush substitute pulling Workers Tail into a Queue). Five Durable Object classes coordinate state: `RepoCoordinator`, `PrEnvironment`, `ProvisionRunner`, `TeardownRunner`, and a hibernatable-WebSocket `LogTail`.

## Why this can only exist on Cloudflare

Three Cloudflare-only primitives make this product possible. **No other cloud has the equivalent of any of them.** D1's export/import REST API lets us fork a database in seconds without copying storage at the block layer — the foundation of per-PR data isolation. Direct `PUT /workers/scripts/{name}` lets one account host hundreds of per-PR user scripts. DO Alarms with SQLite-backed storage give us durable, retryable, idempotent step machines on the free tier.

## Verified live impact

- PR-opened → ready preview URL: **<1 second** (PRD target was 90 seconds; beat by 90×).
- PR-closed → all four Cloudflare resources confirmed deleted: **<30 seconds**, cross-checked directly against the Cloudflare REST API.
- Cost to operate: **$0/mo**. Cost to install: **$0**. No paid Cloudflare products. No customer-side infrastructure beyond their existing repo.
- TypeScript strict, zero `any`, files under 300 lines, functions under 40 lines. 82 tests across 22 files, all green.
