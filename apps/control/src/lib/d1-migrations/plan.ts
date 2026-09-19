/**
 * Which migrations exist in the repo, and which are still pending on the fork.
 *
 * Ordering follows wrangler: lexical with numeric awareness, so
 * `0002_x.sql` < `0010_y.sql`. Only direct children of the migrations dir
 * ending in `.sql` count; nested dirs and non-SQL files are ignored.
 */
import type { RepoTree } from '../github/contents.ts';
import type { MigrationFile } from './types.ts';

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export const listMigrationFiles = (tree: RepoTree, migrationsDir: string): MigrationFile[] => {
  const prefix = migrationsDir.length > 0 ? `${migrationsDir}/` : '';
  const files: MigrationFile[] = [];
  for (const e of tree.tree) {
    if (e.type !== 'blob' || !e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (rel.includes('/') || !rel.toLowerCase().endsWith('.sql')) continue;
    const f: MigrationFile = { name: rel, path: e.path, sha: e.sha };
    if (e.size !== undefined) f.size = e.size;
    files.push(f);
  }
  return files.sort((a, b) => collator.compare(a.name, b.name));
};

export const computePending = (files: MigrationFile[], applied: string[]): MigrationFile[] => {
  const done = new Set(applied);
  return files.filter((f) => !done.has(f.name));
};
