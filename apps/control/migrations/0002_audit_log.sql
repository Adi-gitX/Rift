-- 0002_audit_log.sql — append-only audit trail (PRD §6).

CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_type     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_audit_install_time ON audit_log(installation_id, created_at DESC);
CREATE INDEX idx_audit_target       ON audit_log(target_type, target_id, created_at DESC);
