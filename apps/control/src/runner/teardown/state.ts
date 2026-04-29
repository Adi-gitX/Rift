/**
 * Persisted state for the TeardownRunner DO. Mirrors the ProvisionRunner
 * shape — alarm-driven cursor, per-step result cache for idempotency,
 * exponential backoff on retryable failures, NonRetryableError → failed.
 */

export type TeardownStep =
  | 'mark-tearing-down'
  | 'delete-worker-script'
  | 'delete-d1'
  | 'delete-kv'
  | 'delete-queue'
  | 'purge-bundle-kv'
  | 'evict-do-shard'
  | 'clear-route'
  | 'mark-torn-down';

export const TEARDOWN_STEP_ORDER: readonly TeardownStep[] = [
  'mark-tearing-down',
  'delete-worker-script',
  'delete-d1',
  'delete-kv',
  'delete-queue',
  'purge-bundle-kv',
  'evict-do-shard',
  'clear-route',
  'mark-torn-down',
];

export type TeardownReason = 'pr_closed' | 'idle_7d' | 'manual' | 'failed' | 'forced';

export interface TeardownRunnerState {
  prEnvId: string;
  installationId: string;
  reason: TeardownReason;
  cursor: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  attempts: number;
  startedAt: number;
  finishedAt?: number;
  errorHistory: { step: TeardownStep; ts: number; message: string; attempt: number }[];
}

export const TEARDOWN_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
export const TEARDOWN_MAX_ATTEMPTS = TEARDOWN_BACKOFF_MS.length;

export const currentTeardownStep = (state: TeardownRunnerState): TeardownStep | null =>
  TEARDOWN_STEP_ORDER[state.cursor] ?? null;
