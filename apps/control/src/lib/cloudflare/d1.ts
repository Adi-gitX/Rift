/**
 * D1 helpers — create/delete + the export-then-import "fork" flow used to
 * clone a base-branch DB into a per-PR fork (PRD §9.3 + amendment A3).
 *
 * Import flow per A3:
 *   POST /database/{id}/import {action:'init', etag}
 *     → { upload_url, filename }
 *   PUT  upload_url with raw SQL bytes
 *   POST /database/{id}/import {action:'ingest', etag, filename}
 *     → returns at_bookmark / status
 *   POST /database/{id}/import {action:'poll', current_bookmark}
 *     → poll until status === 'complete'
 */
import type { CodedError, Result } from '@raft/shared-types';
import { ok, err, CodedError as Coded } from '@raft/shared-types';
import { type CFClient } from './client.ts';
import {
  d1DatabaseSchema,
  d1ExportPollSchema,
  d1ImportInitSchema,
  d1ImportPollSchema,
  type D1DatabaseShape,
  type D1ExportPollShape,
  type D1ImportInitShape,
  type D1ImportPollShape,
} from './schemas.ts';
import { z } from 'zod';

const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 120;

export const createDatabase = (
  client: CFClient,
  name: string,
): Promise<Result<D1DatabaseShape, CodedError>> =>
  client.req({ method: 'POST', path: '/d1/database', body: { name } }, d1DatabaseSchema);

/**
 * Idempotent: try create. On ANY failure, fall back to listing and looking
 * up the resource by name — CF returns inconsistent error shapes across
 * resource types when a name collides (some 409, some 200 with
 * success:false, some 400 with various codes), so it's simpler to treat
 * "create failed AND a matching resource exists" as success. If the
 * lookup also fails to find one, propagate the original create error.
 */
export const findOrCreateDatabase = async (
  client: CFClient,
  name: string,
): Promise<Result<D1DatabaseShape, CodedError>> => {
  const create = await createDatabase(client, name);
  if (create.ok) return create;
  const list = await client.req(
    { method: 'GET', path: `/d1/database?name=${encodeURIComponent(name)}&per_page=100` },
    z.array(z.object({ uuid: z.string(), name: z.string() }).passthrough()),
  );
  if (list.ok) {
    const existing = list.value.find((d) => d.name === name);
    if (existing) return ok(existing);
  }
  return create;
};

export const deleteDatabase = (
  client: CFClient,
  id: string,
): Promise<Result<{ deleted: true }, CodedError>> =>
  client.req(
    { method: 'DELETE', path: `/d1/database/${id}` },
    z.unknown().transform(() => ({ deleted: true as const })),
  );

export const startExport = (
  client: CFClient,
  id: string,
): Promise<Result<D1ExportPollShape, CodedError>> =>
  client.req(
    { method: 'POST', path: `/d1/database/${id}/export`, body: { output_format: 'polling' } },
    d1ExportPollSchema,
  );

export const pollExport = (
  client: CFClient,
  id: string,
  bookmark: string,
): Promise<Result<D1ExportPollShape, CodedError>> =>
  client.req(
    { method: 'POST', path: `/d1/database/${id}/export`, body: { current_bookmark: bookmark } },
    d1ExportPollSchema,
  );

export const initImport = (
  client: CFClient,
  id: string,
  etag: string,
): Promise<Result<D1ImportInitShape, CodedError>> =>
  client.req(
    { method: 'POST', path: `/d1/database/${id}/import`, body: { action: 'init', etag } },
    d1ImportInitSchema,
  );

export const uploadImportSql = async (
  client: CFClient,
  uploadUrl: string,
  sql: string | Uint8Array,
): Promise<Result<{ uploaded: true }, CodedError>> => {
  const r = await client.raw({
    method: 'PUT',
    path: uploadUrl,
    body: sql,
    headers: { 'content-type': 'application/sql' },
    unscoped: true,
  });
  return r.ok ? ok({ uploaded: true as const }) : err(r.error);
};

export const ingestImport = (
  client: CFClient,
  id: string,
  etag: string,
  filename: string,
): Promise<Result<D1ImportPollShape, CodedError>> =>
  client.req(
    {
      method: 'POST',
      path: `/d1/database/${id}/import`,
      body: { action: 'ingest', etag, filename },
    },
    d1ImportPollSchema,
  );

export const pollImport = (
  client: CFClient,
  id: string,
  bookmark: string,
): Promise<Result<D1ImportPollShape, CodedError>> =>
  client.req(
    {
      method: 'POST',
      path: `/d1/database/${id}/import`,
      body: { action: 'poll', current_bookmark: bookmark },
    },
    d1ImportPollSchema,
  );

/**
 * High-level helper: import a SQL dump into an empty database, polling to
 * completion. Caller supplies a sha256 etag of the SQL payload.
 */
export const importSqlAndWait = async (
  client: CFClient,
  databaseId: string,
  sql: string,
  etag: string,
): Promise<Result<{ status: 'complete' }, CodedError>> => {
  const init = await initImport(client, databaseId, etag);
  if (!init.ok) return err(init.error);
  const upload = await uploadImportSql(client, init.value.upload_url, sql);
  if (!upload.ok) return err(upload.error);
  const ingest = await ingestImport(client, databaseId, etag, init.value.filename);
  if (!ingest.ok) return err(ingest.error);
  if (ingest.value.status === 'complete') return ok({ status: 'complete' as const });
  return waitForImport(client, databaseId, ingest.value.at_bookmark ?? '');
};

/**
 * Drive a base-DB export to completion and download the SQL dump as a
 * string. Two-stage flow per PRD §9.3:
 *   1. POST /export → status=active + at_bookmark
 *   2. POST /export with current_bookmark → poll until status=complete
 *   3. GET signed_url → SQL bytes
 */
export const exportSqlAndWait = async (
  client: CFClient,
  databaseId: string,
): Promise<Result<string, CodedError>> => {
  const start = await startExport(client, databaseId);
  if (!start.ok) return err(start.error);
  let current = start.value;
  let attempts = 0;
  while (current.status !== 'complete') {
    if (current.status === 'error') {
      return err(new Coded('E_CF_API', `d1_export_error: ${current.error ?? 'unknown'}`));
    }
    if (++attempts > POLL_MAX_ATTEMPTS) {
      return err(new Coded('E_CF_API', 'd1_export_timeout'));
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const next = await pollExport(client, databaseId, current.at_bookmark ?? '');
    if (!next.ok) return err(next.error);
    current = next.value;
  }
  if (!current.signed_url) {
    return err(new Coded('E_CF_API', 'd1_export_missing_signed_url'));
  }
  let res: Response;
  try {
    res = await fetch(current.signed_url);
  } catch (cause) {
    return err(new Coded('E_CF_API', 'd1_export_download_network', { cause }));
  }
  if (!res.ok) {
    return err(new Coded('E_CF_API', `d1_export_download_status_${res.status}`));
  }
  const sql = await res.text();
  return ok(sql);
};

const waitForImport = async (
  client: CFClient,
  databaseId: string,
  bookmark: string,
): Promise<Result<{ status: 'complete' }, CodedError>> => {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    const r = await pollImport(client, databaseId, bookmark);
    if (!r.ok) return err(r.error);
    if (r.value.status === 'complete') return ok({ status: 'complete' as const });
    if (r.value.status === 'error') {
      return err(new Coded('E_CF_API', `d1_import_error: ${r.value.error ?? 'unknown'}`));
    }
    await new Promise((x) => setTimeout(x, POLL_INTERVAL_MS));
  }
  return err(new Coded('E_CF_API', 'd1_import_timeout'));
};
