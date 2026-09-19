import { describe, expect, it } from 'vitest';
import { computePending, listMigrationFiles } from '../../../../src/lib/d1-migrations/plan.ts';
import type { RepoTree } from '../../../../src/lib/github/contents.ts';

const tree = (paths: string[]): RepoTree => ({
  sha: 't',
  truncated: false,
  tree: paths.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: `s-${p}`, size: 10 })),
});

describe('listMigrationFiles', () => {
  it('orders numerically (0002 before 0010) and ignores non-sql, nested, and other dirs', () => {
    const files = listMigrationFiles(
      tree([
        'migrations/0010_ten.sql',
        'migrations/0002_two.SQL',
        'migrations/0001_one.sql',
        'migrations/README.md',
        'migrations/archive/0000_old.sql',
        'other/0003.sql',
        'wrangler.jsonc',
      ]),
      'migrations',
    );
    expect(files.map((f) => f.name)).toEqual(['0001_one.sql', '0002_two.SQL', '0010_ten.sql']);
    expect(files[0]).toEqual({
      name: '0001_one.sql',
      path: 'migrations/0001_one.sql',
      sha: 's-migrations/0001_one.sql',
      size: 10,
    });
  });

  it('supports a custom dir and returns [] when absent', () => {
    expect(listMigrationFiles(tree(['db/sql/0001.sql']), 'db/sql')).toHaveLength(1);
    expect(listMigrationFiles(tree(['src/index.ts']), 'migrations')).toEqual([]);
  });
});

describe('computePending', () => {
  it('drops names already recorded in d1_migrations, preserving order', () => {
    const files = listMigrationFiles(
      tree(['migrations/0001.sql', 'migrations/0002.sql', 'migrations/0003.sql']),
      'migrations',
    );
    expect(computePending(files, ['0001.sql', '0002.sql']).map((f) => f.name)).toEqual([
      '0003.sql',
    ]);
    expect(computePending(files, [])).toHaveLength(3);
  });
});
