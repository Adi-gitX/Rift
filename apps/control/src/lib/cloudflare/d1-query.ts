/**
 * D1 `/query` REST helper.
 *
 *   POST /accounts/{a}/d1/database/{id}/query  { sql, params? }
 *     → result: [{ results: Row[], success, meta }, ...]   (one per statement)
 *
 * Used by the migration-preview steps to apply the PR's migrations to the
 * forked per-PR database and to read schema metadata from both base and
 * fork. Writes are ALWAYS issued with `noRetry` — CFClient retries POSTs on
 * 429/5xx, which is unsafe for DDL (a `CREATE TABLE` that actually landed
 * before a 502 would fail with "already exists" on the retry).
 */
import type { CodedError, Result } from '@raft/shared-types';
import { err, ok } from '@raft/shared-types';
import { z } from 'zod';
import { type CFClient } from './client.ts';

export const d1QueryResultSchema = z.array(
  z
    .object({
      results: z.array(z.record(z.unknown())).optional(),
      success: z.boolean().optional(),
      meta: z.record(z.unknown()).optional(),
    })
    .passthrough(),
);

export type D1QueryResult = z.infer<typeof d1QueryResultSchema>;

export interface D1QueryOptions {
  /** Bind params for a single-statement query. */
  params?: unknown[];
  /** Default true — see module doc. Pass false only for read-only queries. */
  noRetry?: boolean;
}

export const query = (
  client: CFClient,
  databaseId: string,
  sql: string,
  opts: D1QueryOptions = {},
): Promise<Result<D1QueryResult, CodedError>> =>
  client.req(
    {
      method: 'POST',
      path: `/d1/database/${databaseId}/query`,
      body: opts.params ? { sql, params: opts.params } : { sql },
      noRetry: opts.noRetry ?? true,
    },
    d1QueryResultSchema,
  );

/** Rows of the FIRST statement in `sql`. */
export const queryRows = async <T extends Record<string, unknown>>(
  client: CFClient,
  databaseId: string,
  sql: string,
  opts: D1QueryOptions = {},
): Promise<Result<T[], CodedError>> => {
  const r = await query(client, databaseId, sql, { noRetry: false, ...opts });
  if (!r.ok) return err(r.error);
  return ok((r.value[0]?.results ?? []) as T[]);
};

/**
 * Pull the human-readable SQL error out of a CF `cf_status_4xx` error.
 * CF wraps SQLite errors as `{errors:[{code:7500,message:"..."}]}` in the
 * body; we surface `message` so the PR comment can show e.g.
 * "table posts already exists: SQLITE_ERROR".
 */
export const sqlErrorMessage = (e: CodedError): string => {
  const details = e.details as { body?: string; errors?: { message?: string }[] } | undefined;
  const fromErrors = details?.errors?.[0]?.message;
  if (fromErrors) return fromErrors;
  const body = details?.body;
  if (body) {
    try {
      const parsed = JSON.parse(body) as { errors?: { message?: string }[] };
      const msg = parsed.errors?.[0]?.message;
      if (msg) return msg;
    } catch {
      // fall through
    }
  }
  return e.message;
};
