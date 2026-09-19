/**
 * Apply pending migrations to the forked per-PR D1.
 *
 * Bookkeeping follows wrangler's own convention so a customer's existing
 * `wrangler d1 migrations apply` history on the base DB is honoured: the
 * fork inherits `d1_migrations` from the export, we only run files whose
 * name is not yet recorded there.
 *
 * Failure policy: a SQL error marks that migration `failed`, every later
 * one `skipped`, and returns normally — the caller decides how to surface
 * it. Nothing is inserted into `d1_migrations` for a failed file, so a
 * fixed push re-runs it.
 */
import type { CodedError, Result } from '@raft/shared-types';
import { err, ok } from '@raft/shared-types';
import { type CFClient } from '../cloudflare/client.ts';
import { query, queryRows, sqlErrorMessage } from '../cloudflare/d1-query.ts';
import { chunkStatements, dropTransactionControl, splitSqlStatements } from './split.ts';
import { scanDestructive } from './scan.ts';
import type { DestructiveWarning, MigrationFile, MigrationOutcome } from './types.ts';

/** Byte-for-byte the DDL wrangler creates, so both tools agree. */
export const MIGRATIONS_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)';

export const ensureMigrationsTable = (
  client: CFClient,
  databaseId: string,
): Promise<Result<unknown, CodedError>> => query(client, databaseId, MIGRATIONS_TABLE_DDL);

export const readAppliedMigrations = async (
  client: CFClient,
  databaseId: string,
): Promise<Result<string[], CodedError>> => {
  const ensured = await ensureMigrationsTable(client, databaseId);
  if (!ensured.ok) return err(ensured.error);
  const rows = await queryRows<{ name: string }>(
    client,
    databaseId,
    'SELECT name FROM d1_migrations ORDER BY id ASC',
  );
  if (!rows.ok) return err(rows.error);
  return ok(rows.value.map((r) => r.name));
};

export interface ApplyOneInput {
  name: string;
  sql: string;
}

export interface ApplyOneOutput {
  outcome: MigrationOutcome;
  warnings: DestructiveWarning[];
  notes: string[];
}

const recordApplied = (client: CFClient, databaseId: string, name: string) =>
  query(client, databaseId, 'INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)', {
    params: [name],
  });

export const applyOne = async (
  client: CFClient,
  databaseId: string,
  file: ApplyOneInput,
): Promise<ApplyOneOutput> => {
  const t0 = Date.now();
  const split = dropTransactionControl(splitSqlStatements(file.sql));
  const warnings = scanDestructive(file.name, split.statements);
  const base: MigrationOutcome = {
    name: file.name,
    status: 'applied',
    statements: split.statements.length,
  };
  if (split.statements.length === 0) {
    const empty = await recordApplied(client, databaseId, file.name);
    return {
      outcome: empty.ok ? { ...base, durationMs: Date.now() - t0 } : failed(base, empty.error, t0),
      warnings,
      notes: [...split.warnings, 'empty migration (no statements)'],
    };
  }
  for (const chunk of chunkStatements(split.statements)) {
    const r = await query(client, databaseId, `${chunk.join(';\n')};`);
    if (!r.ok) return { outcome: failed(base, r.error, t0), warnings, notes: split.warnings };
  }
  const rec = await recordApplied(client, databaseId, file.name);
  if (!rec.ok) return { outcome: failed(base, rec.error, t0), warnings, notes: split.warnings };
  return { outcome: { ...base, durationMs: Date.now() - t0 }, warnings, notes: split.warnings };
};

const failed = (base: MigrationOutcome, e: CodedError, t0: number): MigrationOutcome => ({
  ...base,
  status: 'failed',
  durationMs: Date.now() - t0,
  error: sqlErrorMessage(e),
});

export interface ApplyPendingResult {
  outcomes: MigrationOutcome[];
  warnings: DestructiveWarning[];
  notes: string[];
}

/**
 * Sequentially apply `pending`; `fetchSql` loads each file's contents.
 * After the first failure, the rest are recorded as `skipped`.
 */
export const applyPending = async (
  client: CFClient,
  databaseId: string,
  pending: MigrationFile[],
  fetchSql: (file: MigrationFile) => Promise<string>,
): Promise<ApplyPendingResult> => {
  const out: ApplyPendingResult = { outcomes: [], warnings: [], notes: [] };
  let blockedBy: string | null = null;
  for (const file of pending) {
    if (blockedBy) {
      out.outcomes.push({ name: file.name, status: 'skipped', error: `blocked by ${blockedBy}` });
      continue;
    }
    let sql: string;
    try {
      sql = await fetchSql(file);
    } catch (e) {
      out.outcomes.push({ name: file.name, status: 'failed', error: `fetch failed: ${String(e)}` });
      blockedBy = file.name;
      continue;
    }
    const r = await applyOne(client, databaseId, { name: file.name, sql });
    out.outcomes.push(r.outcome);
    out.warnings.push(...r.warnings);
    out.notes.push(...r.notes.map((n) => `${file.name}: ${n}`));
    if (r.outcome.status === 'failed') blockedBy = file.name;
  }
  return out;
};
