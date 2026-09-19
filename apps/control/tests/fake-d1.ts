/**
 * In-memory fake of the D1 REST surface Raft uses, for integration tests.
 *
 * Understands just enough SQL to model schema evolution:
 *   CREATE TABLE [IF NOT EXISTS] · CREATE [UNIQUE] INDEX · DROP TABLE ·
 *   ALTER TABLE … ADD COLUMN / RENAME COLUMN / DROP COLUMN · INSERT INTO ·
 *   DELETE FROM · SELECT name FROM d1_migrations · sqlite_master · PRAGMA
 *   table_info · SELECT COUNT(*).
 * Row counts are tracked per table (not actual rows). Export produces a SQL
 * dump the same engine can re-ingest, so a fork inherits the base's schema,
 * row counts and d1_migrations history exactly like the real flow.
 *
 * Runs on the Node side (miniflare outboundService). Tests seed state over
 * HTTP: POST https://fake-d1.local/seed {db, sql}, GET https://fake-d1.local/dump?db=.
 */

interface Column {
  name: string;
  type: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}

interface Db {
  tables: Map<string, Column[]>;
  indexes: Map<string, string>;
  rows: Map<string, number>;
  migrations: string[];
  hasMigrationsTable: boolean;
}

const dbs = new Map<string, Db>();

const getDb = (id: string): Db => {
  let db = dbs.get(id);
  if (!db) {
    db = {
      tables: new Map(),
      indexes: new Map(),
      rows: new Map(),
      migrations: [],
      hasMigrationsTable: false,
    };
    dbs.set(id, db);
  }
  return db;
};

export const resetFakeD1 = (): void => dbs.clear();

const unq = (s: string): string => s.trim().replace(/^["`[]|["`\]]$/g, '');

class SqlError extends Error {}

const splitTop = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let buf = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(buf);
      buf = '';
    } else buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
};

const parseColumns = (body: string): Column[] => {
  const cols: Column[] = [];
  for (const raw of splitTop(body)) {
    const def = raw.trim();
    if (/^(primary key|foreign key|unique|check|constraint)\b/i.test(def)) continue;
    const m = /^(["`[]?\w+["`\]]?)\s*([A-Za-z]+(?:\(\d+(?:,\s*\d+)?\))?)?(.*)$/s.exec(def);
    if (!m) continue;
    const rest = m[3] ?? '';
    const dflt = /default\s+(\S+)/i.exec(rest);
    cols.push({
      name: unq(m[1] ?? ''),
      type: (m[2] ?? '').toUpperCase(),
      notnull: /not null/i.test(rest) || /primary key/i.test(rest) ? 1 : 0,
      pk: /primary key/i.test(rest) ? 1 : 0,
      dflt_value: dflt?.[1] ?? null,
    });
  }
  return cols;
};

const requireTable = (db: Db, name: string): Column[] => {
  const t = db.tables.get(name);
  if (!t) throw new SqlError(`no such table: ${name}`);
  return t;
};

type Rows = Record<string, unknown>[];

const MASTER_RE = /from\s+sqlite_master/i;

const selectRows = (db: Db, sql: string): Rows => {
  if (/from\s+d1_migrations/i.test(sql)) {
    return db.migrations.map((name, i) => ({ id: i + 1, name }));
  }
  if (MASTER_RE.test(sql)) {
    const rows: Rows = [];
    for (const name of db.tables.keys()) rows.push({ type: 'table', name, tbl_name: name });
    for (const [name, tbl] of db.indexes) rows.push({ type: 'index', name, tbl_name: tbl });
    return rows;
  }
  const count = /count\(\*\)\s+as\s+(\w+)\s+from\s+(["`[]?\w+["`\]]?)/i.exec(sql);
  if (count) {
    const table = unq(count[2] ?? '');
    requireTable(db, table);
    return [{ [count[1] ?? 'n']: db.rows.get(table) ?? 0 }];
  }
  return [];
};

const exec = (db: Db, sql: string, params: unknown[] = []): Rows => {
  const s = sql.trim().replace(/\s+/g, ' ');
  let m: RegExpExecArray | null;
  if (/^pragma table_info\(/i.test(s)) {
    m = /^pragma table_info\((.+)\)$/i.exec(s);
    return requireTable(db, unq(m?.[1] ?? '')).map((c) => ({ ...c, cid: 0 }));
  }
  if (/^select /i.test(s)) return selectRows(db, s);
  if ((m = /^create table (if not exists )?(["`[]?\w+["`\]]?) \((.*)\)$/i.exec(s))) {
    const name = unq(m[2] ?? '');
    if (name === 'd1_migrations') {
      db.hasMigrationsTable = true;
      return [];
    }
    if (db.tables.has(name)) {
      if (m[1]) return [];
      throw new SqlError(`table ${name} already exists: SQLITE_ERROR`);
    }
    db.tables.set(name, parseColumns(m[3] ?? ''));
    db.rows.set(name, 0);
    return [];
  }
  if (
    (m = /^create (unique )?index (if not exists )?(["`[]?\w+["`\]]?) on (["`[]?\w+["`\]]?)/i.exec(
      s,
    ))
  ) {
    const table = unq(m[4] ?? '');
    requireTable(db, table);
    db.indexes.set(unq(m[3] ?? ''), table);
    return [];
  }
  if ((m = /^drop table (if exists )?(["`[]?\w+["`\]]?)$/i.exec(s))) {
    const name = unq(m[2] ?? '');
    if (!db.tables.has(name) && !m[1]) throw new SqlError(`no such table: ${name}`);
    db.tables.delete(name);
    db.rows.delete(name);
    for (const [idx, tbl] of [...db.indexes]) if (tbl === name) db.indexes.delete(idx);
    return [];
  }
  if ((m = /^drop index (if exists )?(["`[]?\w+["`\]]?)$/i.exec(s))) {
    db.indexes.delete(unq(m[2] ?? ''));
    return [];
  }
  if ((m = /^alter table (["`[]?\w+["`\]]?) add (column )?(.+)$/i.exec(s))) {
    const cols = requireTable(db, unq(m[1] ?? ''));
    const col = parseColumns(m[3] ?? '')[0];
    if (col) {
      if (cols.some((c) => c.name === col.name)) {
        throw new SqlError(`duplicate column name: ${col.name}`);
      }
      cols.push(col);
    }
    return [];
  }
  if ((m = /^alter table (["`[]?\w+["`\]]?) rename column (\S+) to (\S+)$/i.exec(s))) {
    const cols = requireTable(db, unq(m[1] ?? ''));
    const col = cols.find((c) => c.name === unq(m?.[2] ?? ''));
    if (!col) throw new SqlError(`no such column: ${m[2]}`);
    col.name = unq(m[3] ?? '');
    return [];
  }
  if ((m = /^alter table (["`[]?\w+["`\]]?) drop (column )?(\S+)$/i.exec(s))) {
    const cols = requireTable(db, unq(m[1] ?? ''));
    const i = cols.findIndex((c) => c.name === unq(m?.[3] ?? ''));
    if (i === -1) throw new SqlError(`no such column: ${m[3]}`);
    cols.splice(i, 1);
    return [];
  }
  if ((m = /^insert (or ignore |or replace )?into (["`[]?\w+["`\]]?)/i.exec(s))) {
    const table = unq(m[2] ?? '');
    if (table === 'd1_migrations') {
      const v = /values \(\s*'([^']+)'\s*\)/i.exec(s);
      const name = v?.[1] ?? (typeof params[0] === 'string' ? params[0] : undefined);
      if (name && !db.migrations.includes(name)) db.migrations.push(name);
      return [];
    }
    requireTable(db, table);
    const from = /select .* from (["`[]?\w+["`\]]?)/i.exec(s);
    const added = from
      ? (db.rows.get(unq(from[1] ?? '')) ?? 0)
      : (s.match(/\),\s*\(/g)?.length ?? 0) + 1;
    db.rows.set(table, (db.rows.get(table) ?? 0) + added);
    return [];
  }
  if ((m = /^delete from (["`[]?\w+["`\]]?)( where .*)?$/i.exec(s))) {
    const table = unq(m[1] ?? '');
    requireTable(db, table);
    if (!m[2]) db.rows.set(table, 0);
    else db.rows.set(table, Math.max(0, (db.rows.get(table) ?? 0) - 1));
    return [];
  }
  if (/^(update|begin|commit|end|rollback)\b/i.test(s)) return [];
  if (/^(select|explain)\b/i.test(s)) return [];
  throw new SqlError(`near "${s.split(' ')[0]}": syntax error`);
};

const splitStatements = (sql: string): string[] =>
  sql
    .split(/;(?=(?:[^']*'[^']*')*[^']*$)/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const runQuery = (dbId: string, sql: string, params?: unknown[]): Response => {
  const db = getDb(dbId);
  const out: { results: Rows; success: boolean; meta: Record<string, unknown> }[] = [];
  try {
    for (const stmt of splitStatements(sql)) {
      out.push({ results: exec(db, stmt, params), success: true, meta: {} });
    }
  } catch (e) {
    if (e instanceof SqlError) {
      return json(
        { success: false, errors: [{ code: 7500, message: e.message }], messages: [], result: [] },
        400,
      );
    }
    throw e;
  }
  return json({ success: true, errors: [], messages: [], result: out });
};

/** SQL dump the same engine can ingest — used by the fake export/import flow. */
export const dumpSql = (dbId: string): string => {
  const db = getDb(dbId);
  const lines: string[] = [];
  for (const [name, cols] of db.tables) {
    const defs = cols.map(
      (c) =>
        `${c.name} ${c.type}${c.pk ? ' PRIMARY KEY' : ''}${c.notnull && !c.pk ? ' NOT NULL' : ''}${
          c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''
        }`,
    );
    lines.push(`CREATE TABLE ${name} (${defs.join(', ')});`);
    for (let i = 0; i < (db.rows.get(name) ?? 0); i++) {
      lines.push(`INSERT INTO ${name} VALUES (0);`);
    }
  }
  for (const [idx, tbl] of db.indexes) lines.push(`CREATE INDEX ${idx} ON ${tbl}(x);`);
  if (db.hasMigrationsTable || db.migrations.length > 0) {
    lines.push(
      'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP);',
    );
    for (const m of db.migrations) lines.push(`INSERT INTO d1_migrations (name) VALUES ('${m}');`);
  }
  return lines.join('\n');
};

export const ingestSql = (dbId: string, sql: string): void => {
  const db = getDb(dbId);
  for (const stmt of splitStatements(sql)) exec(db, stmt);
};

/** Handles fake-d1.local seed/dump helpers used by tests. Returns null when the URL is not ours. */
export const handleFakeD1Admin = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.hostname !== 'fake-d1.local') return null;
  if (url.pathname === '/seed' && request.method === 'POST') {
    const body = (await request.json()) as { db: string; sql: string };
    try {
      ingestSql(body.db, body.sql);
    } catch (e) {
      return json({ error: String(e) }, 400);
    }
    return json({ ok: true });
  }
  if (url.pathname === '/dump') {
    return new Response(dumpSql(url.searchParams.get('db') ?? ''), {
      headers: { 'content-type': 'application/sql' },
    });
  }
  if (url.pathname === '/reset') {
    resetFakeD1();
    return json({ ok: true });
  }
  return json({ error: 'unknown fake-d1 admin route' }, 404);
};
