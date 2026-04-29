-- 0003_billing.sql — daily usage records per installation (PRD §6).

CREATE TABLE usage_records (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  period_start    INTEGER NOT NULL,
  period_end      INTEGER NOT NULL,
  pr_envs_active  INTEGER NOT NULL DEFAULT 0,
  pr_envs_created INTEGER NOT NULL DEFAULT 0,
  d1_size_bytes   INTEGER NOT NULL DEFAULT 0,
  r2_size_bytes   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(installation_id, period_start)
);
CREATE INDEX idx_usage_install ON usage_records(installation_id, period_start DESC);
