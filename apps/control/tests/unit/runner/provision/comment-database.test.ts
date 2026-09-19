import { describe, expect, it } from 'vitest';
import { buildDatabaseSection } from '../../../../src/runner/provision/steps/comment-database.ts';
import type {
  ApplyMigrationsResult,
  ForkBaseDbResult,
  SnapshotSchemaResult,
} from '../../../../src/runner/provision/steps.ts';

const fork: ForkBaseDbResult = {
  source: 'forked',
  baseDatabaseId: '969a17b6-4fa7-41ad-9ec7-e40bfffd4fa9',
  baseDatabaseName: 'raft-demo-source',
  sqlBytes: 2048,
};

const applied: ApplyMigrationsResult = {
  status: 'applied',
  baseDatabaseId: fork.baseDatabaseId ?? '',
  forkDatabaseId: 'fork-1234567890',
  migrationsDir: 'migrations',
  alreadyApplied: ['0001_init.sql'],
  applied: ['0002_add_posts.sql'],
  outcomes: [{ name: '0002_add_posts.sql', status: 'applied', durationMs: 18, statements: 4 }],
  warnings: [],
  notes: [],
  durationMs: 40,
};

const snap: SnapshotSchemaResult = {
  status: 'diffed',
  diff: {
    tablesAdded: ['posts'],
    tablesRemoved: [],
    columnsAdded: [{ table: 'users', column: 'bio', type: 'TEXT' }],
    columnsRemoved: [],
    columnsChanged: [],
    indexesAdded: ['idx_posts_user'],
    indexesRemoved: [],
    rowDeltas: [{ table: 'posts', after: 3 }],
  },
};

describe('buildDatabaseSection', () => {
  it('renders base → fork, applied migrations, and the diff table', () => {
    const lines = buildDatabaseSection({
      'fork-base-db': fork,
      'apply-migrations': applied,
      'snapshot-schema': snap,
    });
    const text = lines.join('\n');
    expect(text).toContain(
      '**Database:** forked from base `raft-demo-source` `969a17b6…` → fork `fork-123…` · 2.0 KB dump',
    );
    expect(text).toContain(
      '**Migrations:** 1 migration applied (`0002_add_posts.sql` 18 ms) · 1 already applied on base',
    );
    expect(text).toContain('| + table | `posts` |');
    expect(text).toContain('| + column | `users.bio` TEXT |');
    expect(text).toContain('| + index | `idx_posts_user` |');
    expect(text).toContain('| rows | posts 0 → 3 |');
    expect(text).not.toContain('<details>');
  });

  it('renders warnings and a failed migration with skipped list', () => {
    const failed: ApplyMigrationsResult = {
      ...applied,
      status: 'failed',
      applied: [],
      outcomes: [
        {
          name: '0002_bad.sql',
          status: 'failed',
          error: 'table users already exists',
          statements: 1,
        },
        { name: '0003_x.sql', status: 'skipped', error: 'blocked by 0002_bad.sql' },
      ],
      warnings: [
        {
          migration: '0003_x.sql',
          kind: 'drop-table',
          severity: 'danger',
          statement: 'DROP TABLE users',
        },
      ],
    };
    const text = buildDatabaseSection({ 'fork-base-db': fork, 'apply-migrations': failed }).join(
      '\n',
    );
    expect(text).toContain(
      '> 🛑 **Destructive statement** (drop-table) in `0003_x.sql`: `DROP TABLE users`',
    );
    expect(text).toContain(
      '> ❌ **Migration failed:** `0002_bad.sql` — table users already exists. Skipped: `0003_x.sql`.',
    );
  });

  it('says why the DB was not forked and folds big diffs into <details>', () => {
    const noFork: ForkBaseDbResult = { source: 'skipped', reason: 'export_failed: cf_status_403' };
    const bigDiff: SnapshotSchemaResult = {
      status: 'diffed',
      diff: { ...snap.diff!, tablesAdded: Array.from({ length: 12 }, (_, i) => `t${i}`) },
    };
    const text = buildDatabaseSection({
      'fork-base-db': noFork,
      'apply-migrations': { ...applied, status: 'noop', applied: [], outcomes: [] },
      'snapshot-schema': bigDiff,
    }).join('\n');
    expect(text).toContain(
      '**Database:** empty per-PR D1 (not forked — export_failed: cf_status_403)',
    );
    expect(text).toContain('**Migrations:** no pending migrations · 1 already applied on base');
    expect(text).toContain('<details><summary>15 schema changes</summary>');
  });

  it('returns nothing for repos without a D1 (static sites, unconfigured)', () => {
    expect(buildDatabaseSection({})).toEqual([]);
    expect(
      buildDatabaseSection({
        'fork-base-db': { source: 'skipped', reason: 'no-base-d1' },
        'apply-migrations': { ...applied, status: 'skipped', reason: 'no-wrangler-d1' },
      }),
    ).toEqual([]);
  });
});
