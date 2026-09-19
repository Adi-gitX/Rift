import { describe, expect, it, vi } from 'vitest';
import { CFClient } from '../../../../src/lib/cloudflare/client.ts';
import {
  MIGRATIONS_TABLE_DDL,
  applyOne,
  applyPending,
  readAppliedMigrations,
} from '../../../../src/lib/d1-migrations/apply.ts';

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
  });
const cfSqlErr = (message: string): Response =>
  new Response(
    JSON.stringify({ success: false, errors: [{ code: 7500, message }], messages: [], result: [] }),
    {
      status: 400,
    },
  );
const okStmt = (results: unknown[] = []) => ({ results, success: true, meta: {} });

const mkClient = (fetcher: typeof fetch) =>
  new CFClient({ accountId: 'a', token: 't', fetcher, baseDelayMs: 0, maxRetries: 3 });

const bodyOf = (
  fetcher: ReturnType<typeof vi.fn>,
  i: number,
): { sql: string; params?: unknown[] } =>
  JSON.parse((fetcher.mock.calls[i]?.[1] as RequestInit).body as string) as {
    sql: string;
    params?: unknown[];
  };

describe('readAppliedMigrations', () => {
  it('creates the d1_migrations table (wrangler DDL) then lists names in id order', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfOk([okStmt()]))
      .mockResolvedValueOnce(cfOk([okStmt([{ name: '0001.sql' }, { name: '0002.sql' }])]));
    const r = await readAppliedMigrations(mkClient(fetcher), 'db');
    expect(r.ok && r.value).toEqual(['0001.sql', '0002.sql']);
    expect(bodyOf(fetcher, 0).sql).toBe(MIGRATIONS_TABLE_DDL);
    expect(fetcher.mock.calls[0]?.[0]).toContain('/d1/database/db/query');
  });
});

describe('applyOne', () => {
  it('runs statements, records the migration, and never retries a write on 5xx', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfOk([okStmt(), okStmt()]))
      .mockResolvedValueOnce(cfOk([okStmt()]));
    const r = await applyOne(mkClient(fetcher), 'db', {
      name: '0002.sql',
      sql: 'CREATE TABLE a (x); CREATE INDEX i ON a(x);',
    });
    expect(r.outcome).toMatchObject({ name: '0002.sql', status: 'applied', statements: 2 });
    expect(bodyOf(fetcher, 0).sql).toBe('CREATE TABLE a (x);\nCREATE INDEX i ON a(x);');
    expect(bodyOf(fetcher, 1)).toEqual({
      sql: 'INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)',
      params: ['0002.sql'],
    });
  });

  it('a 502 on a write is NOT retried (fetcher called once) and surfaces as failed', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 }));
    const r = await applyOne(mkClient(fetcher), 'db', { name: 'm.sql', sql: 'CREATE TABLE a (x)' });
    expect(r.outcome.status).toBe('failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('SQL error → failed with the SQLite message and no d1_migrations insert', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfSqlErr('table a already exists: SQLITE_ERROR'));
    const r = await applyOne(mkClient(fetcher), 'db', { name: 'm.sql', sql: 'CREATE TABLE a (x)' });
    expect(r.outcome).toMatchObject({
      status: 'failed',
      error: 'table a already exists: SQLITE_ERROR',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('scans for destructive statements and strips BEGIN/COMMIT', async () => {
    const fetcher = vi.fn().mockResolvedValue(cfOk([okStmt()]));
    const r = await applyOne(mkClient(fetcher), 'db', {
      name: 'm.sql',
      sql: 'BEGIN; DROP TABLE a; COMMIT;',
    });
    expect(r.warnings.map((w) => w.kind)).toEqual(['drop-table']);
    expect(r.notes).toHaveLength(1);
    expect(bodyOf(fetcher, 0).sql).toBe('DROP TABLE a;');
  });
});

describe('applyPending', () => {
  it('applies sequentially and skips everything after the first failure', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfOk([okStmt()])) // 0001 stmt
      .mockResolvedValueOnce(cfOk([okStmt()])) // 0001 record
      .mockResolvedValueOnce(cfSqlErr('boom')); // 0002 stmt
    const files = ['0001.sql', '0002.sql', '0003.sql'].map((name) => ({
      name,
      path: `migrations/${name}`,
      sha: name,
    }));
    const r = await applyPending(mkClient(fetcher), 'db', files, async (f) => `SELECT '${f.name}'`);
    expect(r.outcomes.map((o) => [o.name, o.status])).toEqual([
      ['0001.sql', 'applied'],
      ['0002.sql', 'failed'],
      ['0003.sql', 'skipped'],
    ]);
    expect(r.outcomes[2]?.error).toBe('blocked by 0002.sql');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('a fetch failure for a file marks it failed and blocks the rest', async () => {
    const fetcher = vi.fn();
    const files = ['a.sql', 'b.sql'].map((name) => ({ name, path: name, sha: name }));
    const r = await applyPending(mkClient(fetcher), 'db', files, async () => {
      throw new Error('github 404');
    });
    expect(r.outcomes[0]).toMatchObject({
      status: 'failed',
      error: 'fetch failed: Error: github 404',
    });
    expect(r.outcomes[1]?.status).toBe('skipped');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
