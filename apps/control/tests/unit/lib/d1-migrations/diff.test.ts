import { describe, expect, it, vi } from 'vitest';
import { CFClient } from '../../../../src/lib/cloudflare/client.ts';
import { diffSchemas, isEmptyDiff } from '../../../../src/lib/d1-migrations/diff.ts';
import { snapshotSchema } from '../../../../src/lib/d1-migrations/snapshot.ts';
import type { ColumnInfo, SchemaSnapshot } from '../../../../src/lib/d1-migrations/types.ts';

const col = (name: string, type = 'TEXT', extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name,
  type,
  notNull: false,
  pk: false,
  defaultValue: null,
  ...extra,
});

const snap = (
  tables: SchemaSnapshot['tables'],
  indexes: SchemaSnapshot['indexes'] = [],
): SchemaSnapshot => ({
  databaseId: 'x',
  tables,
  indexes,
  capturedAt: 0,
});

describe('diffSchemas', () => {
  it('detects added/removed tables, columns, indexes, changed column types and row deltas', () => {
    const base = snap(
      [
        {
          name: 'users',
          columns: [col('id', 'INTEGER', { pk: true, notNull: true }), col('name'), col('legacy')],
          rowCount: 3,
        },
        { name: 'old', columns: [col('id')], rowCount: 1 },
      ],
      [{ name: 'idx_old', table: 'old' }],
    );
    const fork = snap(
      [
        {
          name: 'users',
          columns: [
            col('id', 'INTEGER', { pk: true, notNull: true }),
            col('name', 'VARCHAR'),
            col('bio'),
          ],
          rowCount: 5,
        },
        { name: 'posts', columns: [col('id')], rowCount: 2 },
      ],
      [{ name: 'idx_posts_user', table: 'posts' }],
    );
    expect(diffSchemas(base, fork)).toEqual({
      tablesAdded: ['posts'],
      tablesRemoved: ['old'],
      columnsAdded: [{ table: 'users', column: 'bio', type: 'TEXT' }],
      columnsRemoved: [{ table: 'users', column: 'legacy' }],
      columnsChanged: [{ table: 'users', column: 'name', before: 'TEXT', after: 'VARCHAR' }],
      indexesAdded: ['idx_posts_user'],
      indexesRemoved: ['idx_old'],
      rowDeltas: [
        { table: 'users', before: 3, after: 5 },
        { table: 'posts', after: 2 },
      ],
    });
  });

  it('identical snapshots produce an empty diff', () => {
    const s = snap([{ name: 'a', columns: [col('x')], rowCount: 1 }]);
    expect(isEmptyDiff(diffSchemas(s, s))).toBe(true);
  });
});

describe('snapshotSchema', () => {
  it('maps sqlite_master + positional PRAGMA/COUNT results into a snapshot', async () => {
    const cfOk = (result: unknown): Response =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
      });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        cfOk([
          {
            results: [
              { type: 'index', name: 'idx_u', tbl_name: 'users' },
              { type: 'table', name: 'users', tbl_name: 'users' },
            ],
          },
        ]),
      )
      .mockResolvedValueOnce(
        cfOk([
          {
            results: [
              { name: 'id', type: 'INTEGER', notnull: 1, pk: 1, dflt_value: null },
              { name: 'n', type: 'TEXT', notnull: 0, pk: 0, dflt_value: "'x'" },
            ],
          },
          { results: [{ n: 7 }] },
        ]),
      );
    const r = await snapshotSchema(
      new CFClient({ accountId: 'a', token: 't', fetcher, baseDelayMs: 0 }),
      'db-1',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.indexes).toEqual([{ name: 'idx_u', table: 'users' }]);
    expect(r.value.tables).toEqual([
      {
        name: 'users',
        rowCount: 7,
        columns: [
          { name: 'id', type: 'INTEGER', notNull: true, pk: true, defaultValue: null },
          { name: 'n', type: 'TEXT', notNull: false, pk: false, defaultValue: "'x'" },
        ],
      },
    ]);
    const second = JSON.parse((fetcher.mock.calls[1]?.[1] as RequestInit).body as string) as {
      sql: string;
    };
    expect(second.sql).toBe('PRAGMA table_info("users");\nSELECT COUNT(*) AS n FROM "users";');
  });
});
