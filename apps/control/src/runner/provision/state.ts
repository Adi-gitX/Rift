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
  | 'provision-resources'
  | 'rewrite-bundle'
  | 'upload-script'
  | 'route-and-comment';

// TODO(raft:slice-D) — `prepare-base-export` and `build-bundle` are skipped in v1
// (no D1 fork in demo, customer-side GH Action provides the bundle). Both belong
// in this list before steps 4–8 in the production code path.

export const STEP_ORDER: readonly ProvisionStep[] = [
  'load-config',
  'provision-resources',
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
}

export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
export const MAX_ATTEMPTS = BACKOFF_MS.length;

export const currentStep = (state: ProvisionRunnerState): ProvisionStep | null =>
  STEP_ORDER[state.cursor] ?? null;
