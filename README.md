# Raft

Per-Pull-Request ephemeral preview environments for Cloudflare Workers — with fully isolated D1, Durable Objects, R2, KV, and Queues. Built entirely on Cloudflare.

See [`rift_PRD.md`](./rift_PRD.md) for the full product and engineering specification.

## Repo layout

```
apps/
  control/      # raft-control Worker — webhooks, API, dashboard, cron
  dispatcher/   # raft-dispatcher Worker — routes pr-N--repo.preview.<base> to WfP
  dashboard/    # React SPA served via control Worker static-assets binding
  tail/         # raft-tail Worker — Tail consumer that forwards user-Worker logs to a queue
packages/
  shared-types/ # Result, ApiOk/ApiErr, error codes, types shared across apps
  tsconfig/     # Shared TypeScript configurations
  eslint-config/ # Shared ESLint flat config
infra/
  scripts/      # Bootstrap and one-off operational scripts
```

## Local development

```bash
nvm use            # Node 22
corepack enable    # pnpm via corepack
pnpm install
pnpm --filter @raft/control dev
curl http://localhost:8787/healthz
```

## Coding standards

See PRD §20. Strict TypeScript, no `any`, no default exports (one documented exception: the Workers entrypoint), files <300 lines, functions <40 lines, Zod at every external boundary, Result types for foreseeable failures, structured logger only — no `console.log`.
