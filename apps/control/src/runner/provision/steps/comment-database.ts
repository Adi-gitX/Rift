/**
 * "Database" section of the sticky PR comment: what the PR does to the
 * schema and data, computed against a real fork of the base D1.
 */
import type { SchemaDiff } from '../../../lib/d1-migrations/types.ts';
import type { ApplyMigrationsResult, ForkBaseDbResult, SnapshotSchemaResult } from './types.ts';

const MAX_INLINE_ROWS = 8;
const short = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

const baseLine = (
  fork: ForkBaseDbResult | undefined,
  apply: ApplyMigrationsResult | undefined,
): string => {
  if (!fork || fork.source !== 'forked') {
    const why = fork?.reason ?? 'no base D1 detected';
    return `**Database:** empty per-PR D1 (not forked — ${why})`;
  }
  const baseLabel = fork.baseDatabaseName ? `\`${fork.baseDatabaseName}\` ` : '';
  const kb = fork.sqlBytes ? ` · ${(fork.sqlBytes / 1024).toFixed(1)} KB dump` : '';
  const forkLabel = apply?.forkDatabaseId ? ` → fork \`${short(apply.forkDatabaseId)}\`` : '';
  return `**Database:** forked from base ${baseLabel}\`${short(fork.baseDatabaseId ?? '')}\`${forkLabel}${kb}`;
};

const migrationsLine = (apply: ApplyMigrationsResult | undefined): string | null => {
  if (!apply || apply.status === 'skipped') return null;
  const parts: string[] = [];
  const applied = apply.outcomes.filter((o) => o.status === 'applied');
  if (applied.length > 0) {
    const list = applied.map(
      (o) => `\`${o.name}\`${o.durationMs !== undefined ? ` ${o.durationMs} ms` : ''}`,
    );
    parts.push(
      `${applied.length} migration${applied.length === 1 ? '' : 's'} applied (${list.join(', ')})`,
    );
  } else if (apply.status === 'noop') {
    parts.push('no pending migrations');
  }
  if (apply.alreadyApplied.length > 0) {
    parts.push(`${apply.alreadyApplied.length} already applied on base`);
  }
  return parts.length > 0 ? `**Migrations:** ${parts.join(' · ')}` : null;
};

const diffRows = (d: SchemaDiff): string[] => {
  const rows: string[] = [];
  for (const t of d.tablesAdded) rows.push(`| + table | \`${t}\` |`);
  for (const t of d.tablesRemoved) rows.push(`| − table | \`${t}\` |`);
  for (const c of d.columnsAdded) rows.push(`| + column | \`${c.table}.${c.column}\` ${c.type} |`);
  for (const c of d.columnsRemoved) rows.push(`| − column | \`${c.table}.${c.column}\` |`);
  for (const c of d.columnsChanged) {
    rows.push(`| ~ column | \`${c.table}.${c.column}\` ${c.before} → ${c.after} |`);
  }
  for (const i of d.indexesAdded) rows.push(`| + index | \`${i}\` |`);
  for (const i of d.indexesRemoved) rows.push(`| − index | \`${i}\` |`);
  const deltas = d.rowDeltas.map((r) => `${r.table} ${r.before ?? 0} → ${r.after ?? 0}`);
  if (deltas.length > 0) rows.push(`| rows | ${deltas.join(' · ')} |`);
  return rows;
};

const diffTable = (snap: SnapshotSchemaResult | undefined): string[] => {
  if (!snap?.diff) return [];
  const rows = diffRows(snap.diff);
  if (rows.length === 0) return ['_No schema or row-count changes vs base._'];
  const table = ['| Schema change | Detail |', '|---|---|', ...rows];
  if (rows.length <= MAX_INLINE_ROWS) return table;
  return [
    `<details><summary>${rows.length} schema changes</summary>`,
    '',
    ...table,
    '',
    '</details>',
  ];
};

const warningBlock = (apply: ApplyMigrationsResult | undefined): string[] => {
  if (!apply) return [];
  const out: string[] = [];
  for (const w of apply.warnings) {
    const icon = w.severity === 'danger' ? '🛑' : '⚠️';
    out.push(
      `> ${icon} **Destructive statement** (${w.kind}) in \`${w.migration}\`: \`${w.statement}\``,
    );
  }
  const failed = apply.outcomes.find((o) => o.status === 'failed');
  if (failed) {
    const skippedNames = apply.outcomes
      .filter((o) => o.status === 'skipped')
      .map((o) => `\`${o.name}\``);
    const tail = skippedNames.length > 0 ? ` Skipped: ${skippedNames.join(', ')}.` : '';
    out.push(
      `> ❌ **Migration failed:** \`${failed.name}\` — ${failed.error ?? 'unknown error'}.${tail}`,
    );
  }
  return out;
};

/**
 * Lines for the Database section. Empty array when the PR has no D1 at
 * all (static sites, unconfigured repos) so the comment stays compact.
 */
export const buildDatabaseSection = (prior: Record<string, unknown>): string[] => {
  const fork = prior['fork-base-db'] as ForkBaseDbResult | undefined;
  const apply = prior['apply-migrations'] as ApplyMigrationsResult | undefined;
  const snap = prior['snapshot-schema'] as SnapshotSchemaResult | undefined;
  const hasDb = (fork && fork.source === 'forked') || (apply && apply.status !== 'skipped');
  if (!hasDb) return [];
  const lines = [baseLine(fork, apply)];
  const mig = migrationsLine(apply);
  if (mig) lines.push(mig);
  const table = diffTable(snap);
  if (table.length > 0) lines.push('', ...table);
  const warnings = warningBlock(apply);
  if (warnings.length > 0) lines.push('', ...warnings);
  return lines;
};
