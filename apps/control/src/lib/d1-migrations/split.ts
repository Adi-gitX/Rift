/**
 * SQL statement splitting for D1 `/query`.
 *
 * D1 accepts multi-statement SQL, but we split ourselves so we can (a) count
 * statements for the PR comment, (b) strip transaction control that D1
 * rejects, and (c) chunk very large migrations under conservative request
 * limits. The splitter is quote-aware ('...', "...", `...`, [...]) and keeps
 * `CREATE TRIGGER ... BEGIN ... END;` bodies intact.
 */

export const DEFAULT_CHUNK_STATEMENTS = 50;
export const DEFAULT_CHUNK_BYTES = 512 * 1024;

/** Remove `-- line` and `/* block *\/` comments outside string literals. */
export const stripSqlComments = (sql: string): string => {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    const next = sql[i + 1];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      i++;
    } else if (ch === '[') {
      quote = ']';
      out += ch;
      i++;
    } else if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
};

const TRIGGER_RE = /^\s*create\s+(temp(orary)?\s+)?trigger\b/i;
const BEGIN_RE = /\bbegin\b/i;
const END_RE = /\bend\s*$/i;

export const splitSqlStatements = (sql: string): string[] => {
  const clean = stripSqlComments(sql);
  const out: string[] = [];
  let buf = '';
  let quote: string | null = null;
  let inTrigger = false;
  for (const ch of clean) {
    buf += ch;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    else if (ch === ';') {
      if (!inTrigger && TRIGGER_RE.test(buf) && BEGIN_RE.test(buf)) inTrigger = true;
      if (inTrigger && !END_RE.test(buf.slice(0, -1))) continue;
      inTrigger = false;
      const stmt = buf.slice(0, -1).trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);
  return out;
};

const TXN_RE =
  /^\s*(begin(\s+(deferred|immediate|exclusive))?(\s+transaction)?|commit(\s+transaction)?|end(\s+transaction)?|rollback(\s+transaction)?)\s*$/i;

/** D1 rejects explicit transactions inside /query — drop them, warn once. */
export const dropTransactionControl = (
  statements: string[],
): { statements: string[]; warnings: string[] } => {
  const kept = statements.filter((s) => !TXN_RE.test(s));
  const warnings =
    kept.length === statements.length
      ? []
      : ['BEGIN/COMMIT statements removed — D1 /query manages transactions itself'];
  return { statements: kept, warnings };
};

export const chunkStatements = (
  statements: string[],
  limits: { maxStatements?: number; maxBytes?: number } = {},
): string[][] => {
  const maxStatements = limits.maxStatements ?? DEFAULT_CHUNK_STATEMENTS;
  const maxBytes = limits.maxBytes ?? DEFAULT_CHUNK_BYTES;
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const s of statements) {
    const size = s.length + 2;
    if (current.length > 0 && (current.length >= maxStatements || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(s);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};
