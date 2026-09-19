import { describe, expect, it } from 'vitest';
import {
  findWranglerEntry,
  parseWranglerD1,
  stripJsonc,
} from '../../../../src/lib/d1-migrations/wrangler-config.ts';
import type { RepoTree } from '../../../../src/lib/github/contents.ts';

const tree = (paths: string[]): RepoTree => ({
  sha: 't',
  truncated: false,
  tree: paths.map((p) => ({ path: p, mode: '100644', type: 'blob', sha: `s-${p}` })),
});

describe('stripJsonc', () => {
  it('removes line + block comments and trailing commas but keeps strings intact', () => {
    const src = `{
      // comment with "quotes" and , commas
      "a": "http://x.y/z", /* block */
      "b": [1, 2,],
      "c": "// not a comment",
    }`;
    expect(JSON.parse(stripJsonc(src))).toEqual({
      a: 'http://x.y/z',
      b: [1, 2],
      c: '// not a comment',
    });
  });
});

describe('parseWranglerD1', () => {
  it('parses wrangler.jsonc with comments and defaults migrations_dir', () => {
    const r = parseWranglerD1(
      `{ "d1_databases": [ { "binding": "DB", "database_name": "prod", "database_id": "abc-123" }, ] } // eof`,
      'wrangler.jsonc',
    );
    expect(r).toEqual({
      databaseId: 'abc-123',
      databaseName: 'prod',
      binding: 'DB',
      migrationsDir: 'migrations',
      source: 'wrangler.jsonc',
    });
  });

  it('honours migrations_dir and normalises leading ./ and trailing slash', () => {
    const r = parseWranglerD1(
      JSON.stringify({ d1_databases: [{ database_id: 'x', migrations_dir: './db/migrations/' }] }),
      'wrangler.json',
    );
    expect(r?.migrationsDir).toBe('db/migrations');
    expect(r?.source).toBe('wrangler.json');
  });

  it('parses the first [[d1_databases]] block in wrangler.toml', () => {
    const toml = `name = "demo"
main = "src/index.ts"

[[d1_databases]]
binding = "DB"
database_name = "prod"
database_id = "toml-id"
migrations_dir = "sql"

[[kv_namespaces]]
binding = "KV"
id = "kv-1"
`;
    expect(parseWranglerD1(toml, 'wrangler.toml')).toEqual({
      databaseId: 'toml-id',
      databaseName: 'prod',
      binding: 'DB',
      migrationsDir: 'sql',
      source: 'wrangler.toml',
    });
  });

  it('returns null when there is no d1_databases, on invalid JSON, or unknown filenames', () => {
    expect(parseWranglerD1('{"name":"x"}', 'wrangler.json')).toBeNull();
    expect(parseWranglerD1('{ not json', 'wrangler.jsonc')).toBeNull();
    expect(parseWranglerD1('name = "x"', 'wrangler.toml')).toBeNull();
    expect(parseWranglerD1('{}', 'package.json')).toBeNull();
  });
});

describe('findWranglerEntry', () => {
  it('prefers jsonc > json > toml and ignores nested configs', () => {
    expect(findWranglerEntry(tree(['wrangler.toml', 'wrangler.jsonc']))?.path).toBe(
      'wrangler.jsonc',
    );
    expect(findWranglerEntry(tree(['wrangler.toml', 'wrangler.json']))?.path).toBe('wrangler.json');
    expect(findWranglerEntry(tree(['apps/x/wrangler.jsonc']))).toBeNull();
  });
});
