/**
 * Persisted state for the ProvisionRunner DO.
 *
 * Each step writes its result into `step:<name>` keys in DO storage; the
 * `state` key holds the orchestration cursor. On alarm fire we read both,
 * reuse any cached step result (idempotency), advance, and re-arm.
 */
import type { ProvisionPRParams } from '../../env.ts';

export type ProvisionStep =
  | 'load-config'
  | 'await-bundle'
  | 'provision-resources'
  | 'fork-base-db'
  | 'rewrite-bundle'
  | 'upload-script'
  | 'route-and-comment';

/**
 * Provision pipeline. Notable branches:
 *   - `await-bundle`: customer-bundle → poll BUNDLES_KV (~5min cap);
 *     static / fallback → no-op.
 *   - `fork-base-db`: if the repo declares a base D1 (or RAFT_DEMO_BASE_D1_ID
 *     is set), export-then-import to seed the per-PR DB with base-branch
 *     schema + data; otherwise no-op (empty DB).
 */
export const STEP_ORDER: readonly ProvisionStep[] = [
  'load-config',
  'await-bundle',
  'provision-resources',
  'fork-base-db',
  'rewrite-bundle',
  'upload-script',
  'route-and-comment',
];

export type RunnerStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface RunnerErrorEntry {
  step: ProvisionStep;
  ts: number;
  message: string;
  attempt: number;
}

export interface StepTiming {
  startedAt?: number;
  finishedAt?: number;
}

export interface ProvisionRunnerState {
  prEnvId: string;
  installationId: string;
  scope: string;
  scriptName: string;
  previewHostname: string;
  params: ProvisionPRParams;
  cursor: number;
  status: RunnerStatus;
  attempts: number;
  startedAt: number;
  finishedAt?: number;
  errorHistory: RunnerErrorEntry[];
  /** Per-step wall-clock timing; populated as steps run. */
  stepTimings?: Partial<Record<ProvisionStep, StepTiming>>;
}

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

export const currentStep = (state: ProvisionRunnerState): ProvisionStep | null =>
  STEP_ORDER[state.cursor] ?? null;
