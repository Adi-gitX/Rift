/**
 * Flag destructive SQL in a migration so reviewers see it in the PR comment
 * before it ever reaches production. Heuristic regex scan over normalised
 * statements; false negatives are possible (e.g. `DELETE ... WHERE 1=1`),
 * false positives are rare because we anchor on statement start.
 */
import type { DestructiveKind, DestructiveWarning } from './types.ts';

interface Rule {
  kind: DestructiveKind;
  severity: DestructiveWarning['severity'];
  test: (normalised: string) => boolean;
}

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

const RULES: Rule[] = [
  { kind: 'drop-table', severity: 'danger', test: (s) => /^drop table\b/.test(s) },
  {
    kind: 'drop-column',
    severity: 'danger',
    test: (s) => /^alter table\b.*\bdrop( column)?\b/.test(s),
  },
  { kind: 'drop-index', severity: 'warning', test: (s) => /^drop index\b/.test(s) },
  { kind: 'rename', severity: 'warning', test: (s) => /^alter table\b.*\brename\b/.test(s) },
  { kind: 'truncate', severity: 'danger', test: (s) => /^truncate\b/.test(s) },
  {
    kind: 'delete-all',
    severity: 'danger',
    test: (s) => /^delete from\b/.test(s) && !/\bwhere\b/.test(s),
  },
  {
    kind: 'update-all',
    severity: 'warning',
    test: (s) => /^update\b/.test(s) && !/\bwhere\b/.test(s),
  },
];

export const scanDestructive = (migration: string, statements: string[]): DestructiveWarning[] => {
  const out: DestructiveWarning[] = [];
  for (const raw of statements) {
    const s = norm(raw);
    const rule = RULES.find((r) => r.test(s));
    if (!rule) continue;
    out.push({
      migration,
      kind: rule.kind,
      severity: rule.severity,
      statement: raw.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return out;
};
