#!/usr/bin/env bash
# Simulate the full Raft demo path against a running raft-control.
#
# Steps:
#   1. POST a synthetic pull_request.opened webhook (HMAC-signed).
#   2. Watch the dashboard endpoint until the PR env reaches 'ready'.
#   3. Hit the dispatcher to confirm the user worker responds.
#   4. POST a synthetic pull_request.closed webhook.
#   5. Watch until the PR env reaches 'torn_down'.
#
# Requires: curl, jq, openssl. Run with:
#   GITHUB_WEBHOOK_SECRET=… RAFT_BASE=https://your-control.workers.dev \
#   RAFT_DISPATCHER=https://raft-dispatcher.your.workers.dev \
#   ./demo/simulate.sh
#
# All three env vars default to local-dev values.

set -euo pipefail

RAFT_BASE="${RAFT_BASE:-http://localhost:8787}"
RAFT_DISPATCHER="${RAFT_DISPATCHER:-http://localhost:8788}"
WEBHOOK_SECRET="${GITHUB_WEBHOOK_SECRET:-test-webhook-secret}"
INSTALL_ID="${INSTALL_ID:-99}"
REPO_FULL="${REPO_FULL:-demo/customer-app}"
PR_NUMBER="${PR_NUMBER:-42}"
HEAD_SHA="${HEAD_SHA:-deadbeefcafe}"

color() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }

post_event() {
  local event="$1" body="$2"
  local sig
  sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')
  curl -sS -X POST "$RAFT_BASE/webhooks/github" \
    -H "content-type: application/json" \
    -H "x-github-event: $event" \
    -H "x-github-delivery: demo-$(date +%s%N)" \
    -H "x-hub-signature-256: sha256=$sig" \
    --data "$body" \
    -w '  → %{http_code}\n'
}

pr_payload() {
  local action="$1"
  cat <<EOF
{"action":"$action","number":$PR_NUMBER,
 "pull_request":{"number":$PR_NUMBER,
   "head":{"sha":"$HEAD_SHA","ref":"feature/demo"},
   "base":{"sha":"basesha","ref":"main"},
   "user":{"login":"demo-bot"}},
 "repository":{"id":7777,"name":"customer-app","full_name":"$REPO_FULL","default_branch":"main"},
 "installation":{"id":$INSTALL_ID}}
EOF
}

scope="pr-$PR_NUMBER"
pr_env_id="$INSTALL_ID:$REPO_FULL:$PR_NUMBER"

color 36 "1/5  Posting pull_request.opened…"
post_event pull_request "$(pr_payload opened)"

color 36 "2/5  Polling /api/v1/prs/$pr_env_id until ready (you must be logged in via cookie)…"
encoded=$(printf '%s' "$pr_env_id" | jq -sRr @uri)
deadline=$(($(date +%s) + 90))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(curl -sS -b "${RAFT_COOKIE:-}" "$RAFT_BASE/api/v1/prs/$encoded" | jq -r '.data.state // empty' || true)
  echo "  state=$state"
  [ "$state" = "ready" ] && break
  sleep 2
done

color 36 "3/5  Hitting dispatcher: $RAFT_DISPATCHER/$scope/visit"
curl -sS "$RAFT_DISPATCHER/$scope/visit" || true
echo

color 36 "4/5  Posting pull_request.closed…"
post_event pull_request "$(pr_payload closed)"

color 36 "5/5  Polling until torn_down…"
deadline=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$deadline" ]; do
  state=$(curl -sS -b "${RAFT_COOKIE:-}" "$RAFT_BASE/api/v1/prs/$encoded" | jq -r '.data.state // empty' || true)
  echo "  state=$state"
  [ "$state" = "torn_down" ] && break
  sleep 2
done

color 32 "Done. Audit trail at $RAFT_BASE/api/v1/audit/$INSTALL_ID"
