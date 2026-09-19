import { describe, expect, it } from 'vitest';
import { scanDestructive } from '../../../../src/lib/d1-migrations/scan.ts';

describe('scanDestructive', () => {
  it('flags each destructive kind with the right severity', () => {
    const w = scanDestructive('m.sql', [
      'DROP TABLE users',
      'ALTER TABLE users DROP COLUMN bio',
      'ALTER TABLE users DROP bio',
      'DROP INDEX idx_x',
      'ALTER TABLE users RENAME COLUMN a TO b',
      'ALTER TABLE users RENAME TO people',
      'DELETE FROM users',
      'UPDATE users SET x = 1',
      'TRUNCATE TABLE users',
    ]);
    expect(w.map((x) => [x.kind, x.severity])).toEqual([
      ['drop-table', 'danger'],
      ['drop-column', 'danger'],
      ['drop-column', 'danger'],
      ['drop-index', 'warning'],
      ['rename', 'warning'],
      ['rename', 'warning'],
      ['delete-all', 'danger'],
      ['update-all', 'warning'],
      ['truncate', 'danger'],
    ]);
    expect(w[0]).toMatchObject({ migration: 'm.sql', statement: 'DROP TABLE users' });
  });

  it('does not flag additive DDL or scoped DML', () => {
    expect(
      scanDestructive('m.sql', [
        'CREATE TABLE posts (id INTEGER)',
        'ALTER TABLE users ADD COLUMN bio TEXT',
        'DELETE FROM users WHERE id = 1',
        'UPDATE users SET x = 1 WHERE id = 2',
        'CREATE INDEX i ON users(x)',
        "INSERT INTO t VALUES ('drop table nope')",
      ]),
    ).toEqual([]);
  });

  it('truncates long statements in the warning', () => {
    const long = `DROP TABLE ${'x'.repeat(300)}`;
    expect(scanDestructive('m.sql', [long])[0]?.statement).toHaveLength(160);
  });
});
