# Raft Configuration Checklist

Every `REPLACE_ME` in the project, with where to source it.

## 1 — Cloudflare account

| Field | Where to find it | Goes into |
|---|---|---|
| `CF_OWN_ACCOUNT_ID` | dash.cloudflare.com → right sidebar → Account ID | `apps/control/wrangler.jsonc.vars` |
| `CF_WORKERS_SUBDOMAIN` | dash.cloudflare.com → Workers & Pages → "Subdomain" (e.g. `myname.workers.dev`) | `apps/control/wrangler.jsonc.vars` and `apps/dispatcher/wrangler.jsonc.vars` |
| `CF_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token. Permissions needed: **Account → Workers Scripts:Edit, D1:Edit, KV Storage:Edit, Queues:Edit**. | `wrangler secret put CF_API_TOKEN` (control Worker — production source of all per-PR provisioning auth) |

## 2 — Bootstrap resources

Run `./infra/scripts/bootstrap.sh`. It creates and prints the IDs for:

- D1: `raft-meta` → goes into `apps/control/wrangler.jsonc.d1_databases[0].database_id`
- KV: `CACHE`, `ROUTES`, `BUNDLES_KV` → `kv_namespaces[].id`
- Queues: `raft-events`, `raft-events-dlq`, `raft-tail-events` → already named, no IDs needed in config

After bootstrap:

```bash
pnpm --filter @raft/control exec wrangler d1 migrations apply raft-meta --remote
```

## 3 — GitHub App (one-time setup)

1. Go to `https://github.com/settings/apps/new`.
2. Name: `raft-yourorg-dev` (or whatever).
3. Webhook URL: `https://<your-control-subdomain>.workers.dev/webhooks/github`.
4. Webhook secret: generate a 32-char random string. Save it.
5. Permissions:
   - **Repository → Contents: Read**
   - **Repository → Pull requests: Read & write** (for sticky comments)
   - **Repository → Metadata: Read**
6. Subscribe to events: `Pull request`, `Installation`, `Installation repositories`.
7. Generate a private key (PEM). Save it.
8. Note the App ID and Client ID from the app settings page.

Set secrets:

```bash
pnpm --filter @raft/control exec wrangler secret put GITHUB_APP_ID            # the numeric App ID
pnpm --filter @raft/control exec wrangler secret put GITHUB_WEBHOOK_SECRET    # the random string from step 4
pnpm --filter @raft/control exec wrangler secret put GITHUB_APP_PRIVATE_KEY   # paste the PEM (multiline ok)
```

## 4 — Internal secrets

```bash
# 32-byte random session-signing key (also serves as the "shared key" you type at /login).
pnpm --filter @raft/control exec wrangler secret put SESSION_SIGNING_KEY

# 32-byte random secret the dispatcher injects into user worker headers.
pnpm --filter @raft/control exec wrangler secret put INTERNAL_DISPATCH_SECRET
pnpm --filter @raft/dispatcher exec wrangler secret put INTERNAL_DISPATCH_SECRET
```

Generate with:

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
```

## 5 — Local dev (.dev.vars)

Copy `apps/control/.dev.vars.example` → `apps/control/.dev.vars` and fill in the
same secrets. Do NOT commit `.dev.vars` (it's in `.gitignore`).

## 6 — Deploy

```bash
pnpm --filter @raft/control deploy
pnpm --filter @raft/dispatcher deploy
pnpm --filter @raft/tail deploy
```

## 7 — Try it

1. Install your GitHub App on a test repo.
2. Open a PR.
3. Watch `/dashboard/prs/<id>` — state should walk pending → provisioning → ready.
4. Hit `https://<dispatcher>.workers.dev/pr-<n>--<repo>/` to see the preview response.
5. Close the PR; state walks to torn_down.

Free-tier caps to remember:

- **100 Workers / account** → ~95 concurrent PR previews, then provisioning
  step `upload-script` will start failing. Tear down old envs to free slots.
- **10 D1 dbs free** → throttle to ~9 active forks per account.
- **1000 KV reads/day** on the free tier; the dashboard's polling interval
  is 5s — fine for a single operator, watch out for many tabs.
