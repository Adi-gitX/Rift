/**
 * Detect the customer's base D1 database from their wrangler config.
 *
 * We read `wrangler.{jsonc,json,toml}` at the PR head SHA and take the first
 * `d1_databases` entry. That database is the "production" DB the PR would
 * otherwise run against — Raft forks it per PR instead.
 *
 * Scope (documented limitation): top-level config only; `env.*` overrides
 * are ignored. TOML support is a minimal regex over the first
 * `[[d1_databases]]` block — enough for the common single-DB layout.
 */
import type { RepoTree, RepoTreeEntry } from '../github/contents.ts';
import type { WranglerD1Config } from './types.ts';

const DEFAULT_MIGRATIONS_DIR = 'migrations';
const CONFIG_PRECEDENCE = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'] as const;

export const findWranglerEntry = (tree: RepoTree): RepoTreeEntry | null => {
  for (const name of CONFIG_PRECEDENCE) {
    const hit = tree.tree.find((e) => e.type === 'blob' && e.path === name);
    if (hit) return hit;
  }
  return null;
};

/**
 * Strip `//` and `/* *\/` comments (outside string literals) and trailing
 * commas so `JSON.parse` accepts a JSONC document.
 */
export const stripJsonc = (text: string): string => {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
};

interface RawD1Entry {
  database_id?: unknown;
  database_name?: unknown;
  binding?: unknown;
  migrations_dir?: unknown;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

const fromEntry = (
  entry: RawD1Entry,
  source: WranglerD1Config['source'],
): WranglerD1Config | null => {
  const databaseId = str(entry.database_id);
  if (!databaseId) return null;
  const out: WranglerD1Config = {
    databaseId,
    migrationsDir:
      str(entry.migrations_dir)?.replace(/^\.?\/+|\/+$/g, '') ?? DEFAULT_MIGRATIONS_DIR,
    source,
  };
  const name = str(entry.database_name);
  const binding = str(entry.binding);
  if (name) out.databaseName = name;
  if (binding) out.binding = binding;
  return out;
};

const parseJsonLike = (
  text: string,
  source: 'wrangler.jsonc' | 'wrangler.json',
): WranglerD1Config | null => {
  let doc: { d1_databases?: unknown };
  try {
    doc = JSON.parse(stripJsonc(text)) as { d1_databases?: unknown };
  } catch {
    return null;
  }
  const list = Array.isArray(doc.d1_databases) ? (doc.d1_databases as RawD1Entry[]) : [];
  const first = list[0];
  return first ? fromEntry(first, source) : null;
};

const tomlValue = (block: string, key: string): string | undefined => {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(block);
  return m?.[1];
};

const parseToml = (text: string): WranglerD1Config | null => {
  const start = text.indexOf('[[d1_databases]]');
  if (start === -1) return null;
  const rest = text.slice(start + '[[d1_databases]]'.length);
  const nextHeader = rest.search(/^\s*\[/m);
  const block = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
  return fromEntry(
    {
      database_id: tomlValue(block, 'database_id'),
      database_name: tomlValue(block, 'database_name'),
      binding: tomlValue(block, 'binding'),
      migrations_dir: tomlValue(block, 'migrations_dir'),
    },
    'wrangler.toml',
  );
};

export const parseWranglerD1 = (text: string, filename: string): WranglerD1Config | null => {
  if (filename.endsWith('.toml')) return parseToml(text);
  if (filename.endsWith('.jsonc')) return parseJsonLike(text, 'wrangler.jsonc');
  if (filename.endsWith('.json')) return parseJsonLike(text, 'wrangler.json');
  return null;
};
