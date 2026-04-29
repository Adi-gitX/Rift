/**
 * D1 row types (raw SQLite shapes) and entity types (parsed/normalized).
 * Row types use snake_case fields; entities use camelCase + parsed JSON.
 */
export type AccountType = 'user' | 'organization';
export type Plan = 'free' | 'pro' | 'team';

export type PrEnvState =
  | 'pending'
  | 'provisioning'
  | 'ready'
  | 'updating'
  | 'failed'
  | 'tearing_down'
  | 'torn_down';

export type DeploymentStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface InstallationRow {
  id: string;
  github_account: string;
  github_account_id: number;
  account_type: AccountType;
  cloudflare_account_id: string | null;
  cloudflare_token_secret_id: string | null;
  plan: Plan;
  active: number;
  installed_at: number;
  uninstalled_at: number | null;
  config_json: string;
}

export interface Installation {
  id: string;
  githubAccount: string;
  githubAccountId: number;
  accountType: AccountType;
  cloudflareAccountId: string | null;
  cloudflareTokenSecretId: string | null;
  plan: Plan;
  active: boolean;
  installedAt: number;
  uninstalledAt: number | null;
  config: Record<string, unknown>;
}

export interface RepoRow {
  id: string;
  installation_id: string;
  github_repo_id: number;
  full_name: string;
  default_branch: string;
  base_d1_id: string | null;
  base_kv_id: string | null;
  base_r2_bucket: string | null;
  base_queue_name: string | null;
  do_class_names: string;
  raft_config_json: string;
  upload_token_hash: string;
  created_at: number;
}

export interface Repo {
  id: string;
  installationId: string;
  githubRepoId: number;
  fullName: string;
  defaultBranch: string;
  baseD1Id: string | null;
  baseKvId: string | null;
  baseR2Bucket: string | null;
  baseQueueName: string | null;
  doClassNames: string[];
  raftConfig: Record<string, unknown>;
  uploadTokenHash: string;
  createdAt: number;
}

export interface PrEnvironmentRow {
  id: string;
  repo_id: string;
  pr_number: number;
  state: PrEnvState;
  state_reason: string | null;
  head_sha: string;
  preview_hostname: string | null;
  runner_do_id: string | null;
  d1_database_id: string | null;
  kv_namespace_id: string | null;
  queue_id: string | null;
  worker_script_name: string | null;
  r2_prefix: string | null;
  do_namespace_seed: string | null;
  pr_comment_id: number | null;
  created_at: number;
  ready_at: number | null;
  last_activity_at: number;
  torn_down_at: number | null;
}

export interface PrEnvironment {
  id: string;
  repoId: string;
  prNumber: number;
  state: PrEnvState;
  stateReason: string | null;
  headSha: string;
  previewHostname: string | null;
  runnerDoId: string | null;
  resources: {
    d1DatabaseId: string | null;
    kvNamespaceId: string | null;
    queueId: string | null;
    workerScriptName: string | null;
    r2Prefix: string | null;
    doNamespaceSeed: string | null;
  };
  prCommentId: number | null;
  createdAt: number;
  readyAt: number | null;
  lastActivityAt: number;
  tornDownAt: number | null;
}

export interface DeploymentRow {
  id: string;
  pr_env_id: string;
  head_sha: string;
  bundle_r2_key: string;
  status: DeploymentStatus;
  error_message: string | null;
  duration_ms: number | null;
  started_at: number;
  finished_at: number | null;
}

export interface Deployment {
  id: string;
  prEnvId: string;
  headSha: string;
  bundleR2Key: string;
  status: DeploymentStatus;
  errorMessage: string | null;
  durationMs: number | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface AuditLogRow {
  id: string;
  installation_id: string;
  actor: string;
  action: string;
  target_type: string;
  target_id: string;
  metadata_json: string;
  created_at: number;
}

export interface AuditEntry {
  id: string;
  installationId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface UsageRecordRow {
  id: string;
  installation_id: string;
  period_start: number;
  period_end: number;
  pr_envs_active: number;
  pr_envs_created: number;
  d1_size_bytes: number;
  r2_size_bytes: number;
}

export interface UsageRecord {
  id: string;
  installationId: string;
  periodStart: number;
  periodEnd: number;
  prEnvsActive: number;
  prEnvsCreated: number;
  d1SizeBytes: number;
  r2SizeBytes: number;
}
