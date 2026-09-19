import { describe, expect, it } from 'vitest';
import {
  chunkStatements,
  dropTransactionControl,
  splitSqlStatements,
  stripSqlComments,
} from '../../../../src/lib/d1-migrations/split.ts';

describe('stripSqlComments', () => {
  it('strips -- and /* */ comments but not inside string literals', () => {
    const sql = `INSERT INTO t VALUES ('a -- not comment', "b /* nope */"); -- trailing\n/* block\n */ SELECT 1;`;
    expect(stripSqlComments(sql).replace(/\s+/g, ' ').trim()).toBe(
      `INSERT INTO t VALUES ('a -- not comment', "b /* nope */"); SELECT 1;`,
    );
  });
});

describe('splitSqlStatements', () => {
  it('splits on semicolons outside quotes and drops empty statements', () => {
    const stmts = splitSqlStatements(
      `CREATE TABLE a (x TEXT);\n\nINSERT INTO a VALUES ('x;y');;\nSELECT 1`,
    );
    expect(stmts).toEqual(['CREATE TABLE a (x TEXT)', "INSERT INTO a VALUES ('x;y')", 'SELECT 1']);
  });

  it('keeps a CREATE TRIGGER body with inner semicolons as one statement', () => {
    const sql = `CREATE TRIGGER t AFTER INSERT ON a BEGIN UPDATE a SET x = 1; DELETE FROM b; END; SELECT 2;`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatch(/^CREATE TRIGGER/);
    expect(stmts[0]).toMatch(/END$/);
    expect(stmts[1]).toBe('SELECT 2');
  });

  it('handles bracket-quoted identifiers', () => {
    expect(splitSqlStatements(`SELECT [a;b] FROM t; SELECT 1`)).toEqual([
      'SELECT [a;b] FROM t',
      'SELECT 1',
    ]);
  });
});

describe('dropTransactionControl', () => {
  it('removes BEGIN/COMMIT/ROLLBACK and warns once', () => {
    const r = dropTransactionControl(['BEGIN TRANSACTION', 'CREATE TABLE a (x)', 'COMMIT']);
    expect(r.statements).toEqual(['CREATE TABLE a (x)']);
    expect(r.warnings).toHaveLength(1);
  });
  it('is a no-op without transaction statements', () => {
    expect(dropTransactionControl(['SELECT 1']).warnings).toEqual([]);
  });
});

describe('chunkStatements', () => {
  it('splits by statement count and by byte budget', () => {
    const many = Array.from({ length: 120 }, (_, i) => `SELECT ${i}`);
    const chunks = chunkStatements(many);
    expect(chunks.map((c) => c.length)).toEqual([50, 50, 20]);
    const big = ['x'.repeat(600), 'y'.repeat(600), 'z'];
    expect(chunkStatements(big, { maxBytes: 1000 }).map((c) => c.length)).toEqual([1, 2]);
  });
});
