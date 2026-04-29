#!/usr/bin/env bash
# Idempotent bootstrap of every Cloudflare resource Raft needs.
#
# Run from repo root. Requires: wrangler, jq.
#
#   ./infra/scripts/bootstrap.sh
#
# Outputs the IDs of every resource so you can paste them into:
#   apps/control/wrangler.jsonc
#   apps/dispatcher/wrangler.jsonc
#   apps/tail/wrangler.jsonc
#
# Idempotency: each `wrangler X create` is wrapped in a guard that checks
# `wrangler X list` first, so re-running this script is safe.

set -euo pipefail

cd "$(dirname "$0")/../../apps/control"

WRANGLER="pnpm exec wrangler"

# Map "name" → bash function `ensure_X` that creates the resource if missing
# and prints `<binding>=<id>` on stdout.

ensure_d1() {
  local name="$1"
  local existing
  existing=$($WRANGLER d1 list --json 2>/dev/null | jq -r ".[] | select(.name==\"$name\") | .uuid" || true)
  if [[ -z "$existing" ]]; then
    echo "↳ creating D1 $name…" >&2
    existing=$($WRANGLER d1 create "$name" --json 2>/dev/null | jq -r '.d1_databases[0].database_id // .uuid')
  fi
  echo "$existing"
}

ensure_kv() {
  local title="$1"
  local existing
  existing=$($WRANGLER kv namespace list --json 2>/dev/null | jq -r ".[] | select(.title==\"$title\") | .id" || true)
  if [[ -z "$existing" ]]; then
    echo "↳ creating KV $title…" >&2
    existing=$($WRANGLER kv namespace create "$title" --json 2>/dev/null | jq -r '.id')
  fi
  echo "$existing"
}

ensure_queue() {
  local name="$1"
  local existing
  existing=$($WRANGLER queues list --json 2>/dev/null | jq -r ".[] | select(.queue_name==\"$name\") | .queue_id" || true)
  if [[ -z "$existing" ]]; then
    echo "↳ creating queue $name…" >&2
    $WRANGLER queues create "$name" >/dev/null
    existing=$($WRANGLER queues list --json 2>/dev/null | jq -r ".[] | select(.queue_name==\"$name\") | .queue_id")
  fi
  echo "$existing"
}

main() {
  echo "→ Bootstrapping Raft control-plane resources…" >&2

  D1_META=$(ensure_d1 raft-meta)
  KV_CACHE=$(ensure_kv raft-cache)
  KV_ROUTES=$(ensure_kv raft-routes)
  KV_BUNDLES=$(ensure_kv raft-bundles-kv)
  Q_EVENTS=$(ensure_queue raft-events)
  Q_DLQ=$(ensure_queue raft-events-dlq)
  Q_TAIL=$(ensure_queue raft-tail-events)

  cat <<EOF

────────────────────────────────────────────────────────────
Resource IDs — paste into wrangler.jsonc files
────────────────────────────────────────────────────────────
D1
  raft-meta              = $D1_META
KV
  CACHE      (raft-cache)        = $KV_CACHE
  ROUTES     (raft-routes)       = $KV_ROUTES
  BUNDLES_KV (raft-bundles-kv)   = $KV_BUNDLES
Queues
  raft-events            = $Q_EVENTS
  raft-events-dlq        = $Q_DLQ
  raft-tail-events       = $Q_TAIL

Next:
  1. Update apps/control/wrangler.jsonc with the IDs above.
  2. Apply migrations:
       pnpm --filter @raft/control exec wrangler d1 migrations apply raft-meta --remote
  3. Set secrets:
       pnpm --filter @raft/control exec wrangler secret put GITHUB_WEBHOOK_SECRET
       pnpm --filter @raft/control exec wrangler secret put GITHUB_APP_PRIVATE_KEY
       pnpm --filter @raft/control exec wrangler secret put SESSION_SIGNING_KEY
       pnpm --filter @raft/control exec wrangler secret put INTERNAL_DISPATCH_SECRET
       pnpm --filter @raft/control exec wrangler secret put CF_DEMO_API_TOKEN
  4. Deploy:
       pnpm --filter @raft/control deploy
       pnpm --filter @raft/dispatcher deploy
       pnpm --filter @raft/tail deploy
────────────────────────────────────────────────────────────
EOF
}

main "$@"
