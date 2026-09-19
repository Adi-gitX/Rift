/**
 * Result types for every ProvisionRunner step. Persisted as JSON in DO
 * storage and returned verbatim by GET /api/pr-environments/:id/runner, so
 * the dashboard renders straight from these shapes.
 */
import type { CustomerWranglerSummary } from '../../../lib/bundle-rewriter/types.ts';
import type {
  DestructiveWarning,
  MigrationFile,
  MigrationOutcome,
  SchemaDiff,
  SchemaSnapshot,
} from '../../../lib/d1-migrations/types.ts';

export type LoadConfigMode = 'customer-bundle' | 'static' | 'fallback';

export interface StaticSynthSummary {
  fileCount: number;
  totalBytes: number;
  warnings: string[];
}

/** What load-config learned about the customer's database setup. */
export interface DbConfigSummary {
  baseDatabaseId?: string;
  baseDatabaseName?: string;
  binding?: string;
  migrationsDir: string;
  wranglerPath?: string;
  migrationFiles: MigrationFile[];
}

export interface LoadConfigResult {
  wrangler: CustomerWranglerSummary;
  bundleR2Key: string;
  /**
   * How the bundle for this PR is being produced.
   *   'customer-bundle' — repo has a wrangler config; the GH Action uploads
   *                       the built bundle to /api/v1/bundles/upload.
   *   'static'          — Raft synthesised a Worker from the customer's
   *                       static files at headSha. No CI required.
   *   'fallback'        — No customer code source recognised; Raft uploads
   *                       its placeholder so the lifecycle still completes.
   */
  mode: LoadConfigMode;
  /** Set when mode === 'static'. The full synthesised module source. */
  staticBundleSource?: string;
  /** Compact summary for dashboard display. */
  staticSynth?: StaticSynthSummary;
  /** Present when a wrangler config declaring `d1_databases` was found. */
  db?: DbConfigSummary;
}

export interface ProvisionResourcesResult {
  d1: { binding: string; database_id: string; database_name: string };
  kv: { binding: string; id: string; title: string };
  // queue_name is what user-Worker bindings reference; queue_id (UUID) is
  // what the CF API DELETE endpoint requires. Track both — bundle rewriter
  // uses the name; teardown uses the id.
  queue: { binding: string; queue_name: string; queue_id: string };
  r2Prefix: string;
}

export interface ForkBaseDbResult {
  source: 'skipped' | 'forked';
  /** When source==='forked', the source DB id we read from. */
  baseDatabaseId?: string;
  baseDatabaseName?: string;
  /** When source==='forked', byte length of the SQL dump. */
  sqlBytes?: number;
  /** Reason for skip: 'no-base-d1' | 'self-fork-blocked' | 'export_failed: …' | 'import_failed: …'. */
  reason?: string;
}

export interface ApplyMigrationsResult {
  status: 'applied' | 'noop' | 'failed' | 'skipped';
  /** Why the step was skipped entirely (no wrangler d1, no migrations dir, …). */
  reason?: string;
  baseDatabaseId?: string;
  forkDatabaseId?: string;
  migrationsDir?: string;
  /** Names already present in the fork's d1_migrations (inherited from base). */
  alreadyApplied: string[];
  /** Names applied in this run, in order. */
  applied: string[];
  outcomes: MigrationOutcome[];
  warnings: DestructiveWarning[];
  notes: string[];
  durationMs: number;
}

export interface SnapshotSchemaResult {
  status: 'diffed' | 'fork-only' | 'partial' | 'skipped';
  reason?: string;
  fork?: SchemaSnapshot;
  base?: SchemaSnapshot;
  diff?: SchemaDiff;
  error?: string;
}

export interface RewriteBundleResult {
  bindings: unknown[];
  modulesCount: number;
  warnings: string[];
  /** The actual main_module name in the rewritten bundle. For customer-bundle
   *  mode this is the customer's main module (e.g. "index.js"); for
   *  static / fallback this is what the synth template emits. */
  mainModule: string;
  compatibilityDate: string;
  compatibilityFlags?: string[];
}

export interface UploadScriptResult {
  scriptId: string;
  etag?: string;
}

export interface RouteAndCommentResult {
  hostname: string;
  scriptName: string;
  routeKvKey: string;
  /** GitHub comment id, if the sticky-comment post succeeded. */
  prCommentId?: number;
  /** True if a new comment was posted; false if an existing one was updated. */
  prCommentCreated?: boolean;
  /** Set when the GitHub call failed. The provision still succeeds. */
  prCommentSkippedReason?: string;
}

export interface AwaitBundleResult {
  /** Modes that need a customer bundle from the GH-Action upload. */
  source: 'customer-bundle' | 'static-synth' | 'placeholder';
  /** Set when source==='customer-bundle'; the BUNDLES_KV key carrying the bundle. */
  bundleKey?: string;
  /** Set when source==='customer-bundle'; bytes of the uploaded payload. */
  bundleBytes?: number;
  /** SHA-256 of the bundle bytes (hex). Used for smart-redeploy short-circuit. */
  bundleEtag?: string;
  /** Wall-clock waiting time, ms — surfaced in the dashboard. */
  waitedMs: number;
}

export interface UploadedBundlePayload {
  wrangler: {
    main_module?: string;
    compatibility_date?: string;
    compatibility_flags?: string[];
    bindings?: unknown[];
  };
  modules: {
    name: string;
    /** Base64-encoded module bytes. */
    content_b64: string;
    type?: string;
  }[];
  uploadedAt?: number;
  bytes?: number;
}
