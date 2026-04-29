/**
 * Tiny fetch wrapper for the Raft dashboard. Same-origin in prod (raft-control
 * serves both SPA and API). In dev, package.json `proxy` forwards /api/* to
 * the deployed worker. 401 redirects to /login.
 */
const get = async (path) => {
  const r = await fetch(path, { credentials: "same-origin" });
  if (r.status === 401) {
    if (typeof window !== "undefined") window.location.href = "/login";
    return null;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
};

const post = async (path, body) => {
  const r = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && typeof window !== "undefined") {
    window.location.href = "/login";
    return null;
  }
  if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`);
  return r.json();
};

export const api = {
  me:                 () => get("/api/me"),
  stats:              () => get("/api/stats"),
  health:             () => get("/api/health"),
  repos:              () => get("/api/repos"),
  repo:               (id) => get(`/api/repos/${encodeURIComponent(id)}`),
  repoStats:          (id) => get(`/api/repos/${encodeURIComponent(id)}/stats`),
  prEnvironments:     () => get("/api/pr-environments"),
  prEnvironment:      (id) => get(`/api/pr-environments/${encodeURIComponent(id)}`),
  prEnvironmentLogs:  (id) => get(`/api/pr-environments/${encodeURIComponent(id)}/logs`),
  runnerState:        (id) => get(`/api/pr-environments/${encodeURIComponent(id)}/runner`),
  teardownRunnerState:(id) => get(`/api/pr-environments/${encodeURIComponent(id)}/teardown-runner`),
  audit:              () => get("/api/audit"),
  rotateUploadToken:  (repoId) => post(`/api/v1/repos/${encodeURIComponent(repoId)}/rotate-upload-token`),
  teardown:           (prEnvId) => post(`/api/v1/prs/${encodeURIComponent(prEnvId)}/teardown`),
  redeploy:           (prEnvId) => post(`/api/v1/prs/${encodeURIComponent(prEnvId)}/redeploy`),
};

/** State → tone class (matches Inbox StatusBadge tones). */
export const stateTone = (s) => {
  switch (s) {
    case "ready":         return "done";
    case "provisioning":  return "progress";
    case "updating":      return "progress";
    case "pending":       return "triage";
    case "tearing_down":  return "triage";
    case "torn_down":     return "triage";
    case "failed":        return "high";
    default:              return "triage";
  }
};

export const fmtDate = (sec) => {
  if (!sec) return "—";
  const d = new Date(sec * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export const fmtRelative = (sec) => {
  if (!sec) return "—";
  const diff = Math.floor((Date.now() / 1000 - sec));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
};
