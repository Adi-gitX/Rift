/**
 * Structural diff between two schema snapshots (base vs per-PR fork).
 */
import type { ColumnInfo, SchemaDiff, SchemaSnapshot, TableInfo } from './types.ts';

const columnSig = (c: ColumnInfo): string =>
  `${c.type}${c.notNull ? ' NOT NULL' : ''}${c.pk ? ' PK' : ''}${
    c.defaultValue !== null ? ` DEFAULT ${c.defaultValue}` : ''
  }`;

const byName = <T extends { name: string }>(xs: T[]): Map<string, T> =>
  new Map(xs.map((x) => [x.name, x]));

const diffColumns = (diff: SchemaDiff, before: TableInfo, after: TableInfo): void => {
  const b = byName(before.columns);
  const a = byName(after.columns);
  for (const [name, col] of a) {
    const prev = b.get(name);
    if (!prev) {
      diff.columnsAdded.push({ table: after.name, column: name, type: columnSig(col) });
    } else if (columnSig(prev) !== columnSig(col)) {
      diff.columnsChanged.push({
        table: after.name,
        column: name,
        before: columnSig(prev),
        after: columnSig(col),
      });
    }
  }
  for (const name of b.keys()) {
    if (!a.has(name)) diff.columnsRemoved.push({ table: after.name, column: name });
  }
};

export const diffSchemas = (base: SchemaSnapshot, fork: SchemaSnapshot): SchemaDiff => {
  const diff: SchemaDiff = {
    tablesAdded: [],
    tablesRemoved: [],
    columnsAdded: [],
    columnsRemoved: [],
    columnsChanged: [],
    indexesAdded: [],
    indexesRemoved: [],
    rowDeltas: [],
  };
  const b = byName(base.tables);
  const a = byName(fork.tables);
  for (const [name, table] of a) {
    const prev = b.get(name);
    if (!prev) {
      diff.tablesAdded.push(name);
      if (table.rowCount !== undefined) diff.rowDeltas.push({ table: name, after: table.rowCount });
      continue;
    }
    diffColumns(diff, prev, table);
    if (
      prev.rowCount !== undefined &&
      table.rowCount !== undefined &&
      prev.rowCount !== table.rowCount
    ) {
      diff.rowDeltas.push({ table: name, before: prev.rowCount, after: table.rowCount });
    }
  }
  for (const name of b.keys()) if (!a.has(name)) diff.tablesRemoved.push(name);
  const bi = new Set(base.indexes.map((i) => i.name));
  const ai = new Set(fork.indexes.map((i) => i.name));
  for (const i of ai) if (!bi.has(i)) diff.indexesAdded.push(i);
  for (const i of bi) if (!ai.has(i)) diff.indexesRemoved.push(i);
  return diff;
};

export const isEmptyDiff = (d: SchemaDiff): boolean =>
  d.tablesAdded.length === 0 &&
  d.tablesRemoved.length === 0 &&
  d.columnsAdded.length === 0 &&
  d.columnsRemoved.length === 0 &&
  d.columnsChanged.length === 0 &&
  d.indexesAdded.length === 0 &&
  d.indexesRemoved.length === 0 &&
  d.rowDeltas.length === 0;
