/**
 * Shared types for the D1 branching + migration-preview pipeline.
 *
 * Flow per PR: detect base D1 from the customer's wrangler config →
 * fork (export/import) → apply pending `migrations/*.sql` to the fork →
 * snapshot base + fork schema → diff → surface in PR comment + dashboard.
 */

export interface WranglerD1Config {
  databaseId: string;
  databaseName?: string;
  binding?: string;
  /** Relative dir in the repo holding `*.sql` migrations. Default `migrations`. */
  migrationsDir: string;
  /** Which config file the values came from. */
  source: 'wrangler.jsonc' | 'wrangler.json' | 'wrangler.toml';
}

export interface MigrationFile {
  /** Basename, e.g. `0002_add_posts.sql`. Used as the `d1_migrations.name` key. */
  name: string;
  /** Repo-relative path, e.g. `migrations/0002_add_posts.sql`. */
  path: string;
  /** Git blob sha — fetched via GET /git/blobs/{sha}. */
  sha: string;
  size?: number;
}

export type MigrationStatus = 'applied' | 'failed' | 'skipped';

export interface MigrationOutcome {
  name: string;
  status: MigrationStatus;
  durationMs?: number;
  /** Number of SQL statements the file split into. */
  statements?: number;
  /** Populated when status === 'failed' (SQL error) or 'skipped' (blocked by earlier failure). */
  error?: string;
}

export type DestructiveKind =
  | 'drop-table'
  | 'drop-column'
  | 'drop-index'
  | 'rename'
  | 'delete-all'
  | 'update-all'
  | 'truncate';

export interface DestructiveWarning {
  migration: string;
  kind: DestructiveKind;
  /** First ~160 chars of the offending statement. */
  statement: string;
  severity: 'danger' | 'warning';
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  defaultValue: string | null;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
  /** Undefined when the count was skipped (too many tables) or failed. */
  rowCount?: number;
}

export interface IndexInfo {
  name: string;
  table: string;
}

export interface SchemaSnapshot {
  databaseId: string;
  tables: TableInfo[];
  indexes: IndexInfo[];
  capturedAt: number;
}

export interface ColumnChange {
  table: string;
  column: string;
  before: string;
  after: string;
}

export interface SchemaDiff {
  tablesAdded: string[];
  tablesRemoved: string[];
  columnsAdded: { table: string; column: string; type: string }[];
  columnsRemoved: { table: string; column: string }[];
  columnsChanged: ColumnChange[];
  indexesAdded: string[];
  indexesRemoved: string[];
  rowDeltas: { table: string; before?: number; after?: number }[];
}
