-- 0001_init.sql — installations, repos, pr_environments, deployments
-- (PRD §6 + amendment A6: upload_token_hash on repos.)

CREATE TABLE installations (
  id                          TEXT PRIMARY KEY,
  github_account              TEXT NOT NULL,
  github_account_id           INTEGER NOT NULL,
  account_type                TEXT NOT NULL CHECK(account_type IN ('user','organization')),
  cloudflare_account_id       TEXT,
  cloudflare_token_secret_id  TEXT,
  plan                        TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro','team')),
  active                      INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  installed_at                INTEGER NOT NULL,
  uninstalled_at              INTEGER,
  config_json                 TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_installations_active ON installations(active) WHERE active = 1;

CREATE TABLE repos (
  id                          TEXT PRIMARY KEY,
  installation_id             TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  github_repo_id              INTEGER NOT NULL,
  full_name                   TEXT NOT NULL,
  default_branch              TEXT NOT NULL DEFAULT 'main',
  base_d1_id                  TEXT,
  base_kv_id                  TEXT,
  base_r2_bucket              TEXT,
  base_queue_name             TEXT,
  do_class_names              TEXT NOT NULL DEFAULT '[]',
  raft_config_json            TEXT NOT NULL DEFAULT '{}',
  upload_token_hash           TEXT NOT NULL,
  created_at                  INTEGER NOT NULL,
  UNIQUE(installation_id, full_name)
);
CREATE INDEX idx_repos_installation ON repos(installation_id);
CREATE INDEX idx_repos_github       ON repos(github_repo_id);

CREATE TABLE pr_environments (
  id                          TEXT PRIMARY KEY,
  repo_id                     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  pr_number                   INTEGER NOT NULL,
  state                       TEXT NOT NULL CHECK(state IN (
                                'pending','provisioning','ready','updating',
                                'failed','tearing_down','torn_down')),
  state_reason                TEXT,
  head_sha                    TEXT NOT NULL,
  preview_hostname            TEXT,
  runner_do_id                TEXT,
  d1_database_id              TEXT,
  kv_namespace_id             TEXT,
  queue_id                    TEXT,
  worker_script_name          TEXT,
  r2_prefix                   TEXT,
  do_namespace_seed           TEXT,
  pr_comment_id               INTEGER,
  created_at                  INTEGER NOT NULL,
  ready_at                    INTEGER,
  last_activity_at            INTEGER NOT NULL,
  torn_down_at                INTEGER,
  UNIQUE(repo_id, pr_number)
);
CREATE INDEX idx_pr_envs_state    ON pr_environments(state);
CREATE INDEX idx_pr_envs_activity ON pr_environments(last_activity_at);

CREATE TABLE deployments (
  id                          TEXT PRIMARY KEY,
  pr_env_id                   TEXT NOT NULL REFERENCES pr_environments(id) ON DELETE CASCADE,
  head_sha                    TEXT NOT NULL,
  bundle_r2_key               TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
  error_message               TEXT,
  duration_ms                 INTEGER,
  started_at                  INTEGER NOT NULL,
  finished_at                 INTEGER
);
CREATE INDEX idx_deployments_pr ON deployments(pr_env_id, started_at DESC);
