/**
 * Internal helpers for the repo layer.
 *  - safeJson: parses TEXT JSON columns; returns {} on parse failure rather than
 *    throwing, because corrupt JSON in a metadata column should not nuke a read path.
 *  - wrap: turns a thrown D1 error into a Result<E_INTERNAL>. We intentionally keep
 *    this thin — callers add row-mapping after the wrap.
 */
import { CodedError, type Result, ok, err } from '@raft/shared-types';

export const safeJson = (s: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(s);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

export const safeJsonArray = <T = unknown>(s: string): T[] => {
  try {
    const parsed: unknown = JSON.parse(s);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export async function wrap<T>(label: string, fn: () => Promise<T>): Promise<Result<T, CodedError>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(new CodedError('E_INTERNAL', `${label} failed`, { cause: e }));
  }
}
