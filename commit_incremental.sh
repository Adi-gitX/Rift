#!/bin/bash
set -e

# Commit 1
git add apps/control/src/lib/cloudflare/d1.ts apps/control/src/lib/cloudflare/kv.ts apps/control/src/lib/cloudflare/queues.ts
git commit -m "implement: update Cloudflare resource handlers for D1, KV, and Queues"

# Commit 2
git add apps/control/wrangler.jsonc apps/control/src/env.ts
git commit -m "build: update environment configuration and wrangler bindings"

# Commit 3
git add apps/control/src/lib/ai/bundle-review.ts
git commit -m "implement: add AI-powered bundle review helper"

# Commit 4
git add apps/control/src/runner/provision/steps.ts
git commit -m "implement: integrate AI bundle review into provisioning steps"

# Commit 5
git add apps/control/src/do/provision-runner.ts
git commit -m "fix: preserve Cloudflare resources during SHA-dependent redeploys"

# Commit 6
git add apps/control/src/do/repo-coordinator.ts
git commit -m "implement: add quota guard against free-tier D1 and Queue limits"

# Commit 7
git add apps/control/src/routes/dashboard-api.ts apps/control/src/routes/github.ts
git commit -m "implement: update dashboard and GitHub API routes for PR environments"

# Commit 8
git add apps/dashboard/src/App.css apps/dashboard/src/index.js
git commit -m "style: update global dashboard styling and entry point"

# Commit 9
git add apps/dashboard/src/Dashboard.js
git commit -m "implement: enhance main dashboard overview layout"

# Commit 10
git add apps/dashboard/src/dashboard/raft/Repos.jsx
git commit -m "implement: update Repositories view with new data fields"

# Commit 11
git add apps/dashboard/src/dashboard/raft/PrEnvDetail.jsx
git commit -m "implement: update PR Environment Detail view for review statuses"

# Commit 12
git add apps/dashboard/src/dashboard/raft/Settings.jsx
git commit -m "implement: update Settings view for raft configurations"

# Finally, push the commits to GitHub
git push origin main
