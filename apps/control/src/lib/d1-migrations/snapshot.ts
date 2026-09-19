/**
 * Read a D1 database's schema (tables, columns, indexes) and per-table row
 * counts through the REST `/query` endpoint. Works on both the customer's
 * base DB and the per-PR fork so the two can be diffed.
 */
import type { CodedError, Result } from '@raft/shared-types';
import { err, ok } from '@raft/shared-types';
import { type CFClient } from '../cloudflare/client.ts';
import { query, queryRows } from '../cloudflare/d1-query.ts';
import type { ColumnInfo, IndexInfo, SchemaSnapshot, TableInfo } from './types.ts';

/** Above this many tables we skip row counts to keep the step cheap. */
export const MAX_COUNTED_TABLES = 60;

interface MasterRow extends Record<string, unknown> {
  type: string;
  name: string;
  tbl_name: string;
}

interface PragmaRow extends Record<string, unknown> {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export const readSqliteMaster = (
  client: CFClient,
  databaseId: string,
): Promise<Result<MasterRow[], CodedError>> =>
  queryRows<MasterRow>(
    client,
    databaseId,
    `SELECT type, name, tbl_name FROM sqlite_master
      WHERE type IN ('table','index')
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '_cf_%'
        AND name <> 'd1_migrations'
      ORDER BY type, name`,
  );

const toColumn = (r: PragmaRow): ColumnInfo => ({
  name: r.name,
  type: r.type,
  notNull: r.notnull === 1,
  pk: r.pk > 0,
  defaultValue: r.dflt_value,
});

/**
 * One multi-statement request: `PRAGMA table_info(t)` for every table,
 * followed by `SELECT COUNT(*)` for every table (when under the cap).
 * Results come back positionally, one entry per statement.
 */
export const readColumnsAndCounts = async (
  client: CFClient,
  databaseId: string,
  tables: string[],
): Promise<Result<TableInfo[], CodedError>> => {
  if (tables.length === 0) return ok([]);
  const countRows = tables.length <= MAX_COUNTED_TABLES;
  const stmts = tables.map((t) => `PRAGMA table_info(${quoteIdent(t)})`);
  if (countRows) stmts.push(...tables.map((t) => `SELECT COUNT(*) AS n FROM ${quoteIdent(t)}`));
  const r = await query(client, databaseId, `${stmts.join(';\n')};`, { noRetry: false });
  if (!r.ok) return err(r.error);
  const out: TableInfo[] = tables.map((name, i) => ({
    name,
    columns: ((r.value[i]?.results ?? []) as unknown as PragmaRow[]).map(toColumn),
  }));
  if (countRows) {
    tables.forEach((_, i) => {
      const n = r.value[tables.length + i]?.results?.[0]?.['n'];
      const row = out[i];
      if (row && typeof n === 'number') row.rowCount = n;
    });
  }
  return ok(out);
};

export const snapshotSchema = async (
  client: CFClient,
  databaseId: string,
): Promise<Result<SchemaSnapshot, CodedError>> => {
  const master = await readSqliteMaster(client, databaseId);
  if (!master.ok) return err(master.error);
  const tableNames = master.value.filter((r) => r.type === 'table').map((r) => r.name);
  const indexes: IndexInfo[] = master.value
    .filter((r) => r.type === 'index')
    .map((r) => ({ name: r.name, table: r.tbl_name }));
  const tables = await readColumnsAndCounts(client, databaseId, tableNames);
  if (!tables.ok) return err(tables.error);
  return ok({ databaseId, tables: tables.value, indexes, capturedAt: Date.now() });
};
