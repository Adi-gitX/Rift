/**
 * ProvisionRunner step registry (barrel).
 *
 * Implementations live in ./steps/*.ts, one module per step, so each stays
 * under the 300-line / 40-line-function caps. The runner DO and tests import
 * from here.
 */
import { CodedError, type NonRetryableError } from '@raft/shared-types';
import { loadConfig } from './steps/load-config.ts';
import { awaitBundle } from './steps/await-bundle.ts';
import { provisionResources } from './steps/provision-resources.ts';
import { forkBaseDb } from './steps/fork-base-db.ts';
import { applyMigrations } from './steps/apply-migrations.ts';
import { snapshotSchemaStep } from './steps/snapshot-schema.ts';
import { rewriteBundleStep } from './steps/bundle.ts';
import { uploadScript } from './steps/upload-script.ts';
import { routeAndComment } from './steps/route-and-comment.ts';
import type {
  ApplyMigrationsResult,
  AwaitBundleResult,
  ForkBaseDbResult,
  LoadConfigResult,
  ProvisionResourcesResult,
  RewriteBundleResult,
  RouteAndCommentResult,
  SnapshotSchemaResult,
  UploadScriptResult,
} from './steps/types.ts';

export type { StepContext } from './steps/context.ts';
export type * from './steps/types.ts';
export { bundleKvKey } from '../../lib/bundle-key.ts';
export { AWAIT_BUNDLE_PENDING } from './steps/await-bundle.ts';
export {
  loadConfig,
  awaitBundle,
  provisionResources,
  forkBaseDb,
  applyMigrations,
  snapshotSchemaStep,
  rewriteBundleStep,
  uploadScript,
  routeAndComment,
};

export const STEP_FNS = {
  'load-config': loadConfig,
  'await-bundle': awaitBundle,
  'provision-resources': provisionResources,
  'fork-base-db': forkBaseDb,
  'apply-migrations': applyMigrations,
  'snapshot-schema': snapshotSchemaStep,
  'rewrite-bundle': rewriteBundleStep,
  'upload-script': uploadScript,
  'route-and-comment': routeAndComment,
} as const;

export interface StepResultMap {
  'load-config': LoadConfigResult;
  'await-bundle': AwaitBundleResult;
  'provision-resources': ProvisionResourcesResult;
  'fork-base-db': ForkBaseDbResult;
  'apply-migrations': ApplyMigrationsResult;
  'snapshot-schema': SnapshotSchemaResult;
  'rewrite-bundle': RewriteBundleResult;
  'upload-script': UploadScriptResult;
  'route-and-comment': RouteAndCommentResult;
}

export const stepError = (e: unknown): CodedError | NonRetryableError =>
  e instanceof CodedError ? e : new CodedError('E_INTERNAL', String(e));
