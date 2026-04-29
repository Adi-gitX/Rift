/**
 * Workers Scripts — direct upload (free-tier substitution for WfP).
 *
 *   PUT /accounts/{a}/workers/scripts/{name}
 *   Content-Type: multipart/form-data
 *
 *   metadata JSON                 — main_module, bindings[], compatibility_date, ...
 *   <module file(s)>              — each part is a script module
 *
 * Per the slice substitution: 100 scripts/account on Workers Free.
 */
import { z } from 'zod';
import type { CodedError, Result } from '@raft/shared-types';
import { type CFClient } from './client.ts';
import { workerScriptUploadSchema, type WorkerScriptUploadShape } from './schemas.ts';

export interface ScriptModule {
  name: string;
  content: string | Uint8Array;
  contentType: string;
}

export interface WorkerBinding {
  type:
    | 'd1'
    | 'kv_namespace'
    | 'queue'
    | 'r2_bucket'
    | 'plain_text'
    | 'secret_text'
    | 'durable_object_namespace'
    | 'service';
  name: string;
  // Each binding type carries its own additional fields; we keep an open shape.
  [k: string]: unknown;
}

export interface UploadScriptInput {
  scriptName: string;
  mainModule: string;
  modules: ScriptModule[];
  compatibilityDate: string;
  compatibilityFlags?: string[];
  bindings?: WorkerBinding[];
  /** Tail consumer scripts (Slice F's raft-tail) — passed through unchanged. */
  tailConsumers?: { service: string; environment?: string; namespace?: string }[];
  tags?: string[];
}

const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,61}[a-z0-9]$/i;
const MAX_SCRIPT_NAME = 63;

export const validateScriptName = (name: string): boolean =>
  name.length > 0 && name.length <= MAX_SCRIPT_NAME && SCRIPT_NAME_RE.test(name);

export const buildScriptName = (
  installShort: string,
  repoShort: string,
  prNumber: number,
): string => {
  const candidate = `raft-${installShort}-${repoShort}-pr-${prNumber}`.toLowerCase();
  return candidate.slice(0, MAX_SCRIPT_NAME);
};

export const uploadScript = (
  client: CFClient,
  input: UploadScriptInput,
): Promise<Result<WorkerScriptUploadShape, CodedError>> => {
  const form = new FormData();
  const metadata = {
    main_module: input.mainModule,
    compatibility_date: input.compatibilityDate,
    compatibility_flags: input.compatibilityFlags ?? [],
    bindings: input.bindings ?? [],
    tail_consumers: input.tailConsumers ?? [],
    tags: input.tags ?? [],
  };
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  for (const m of input.modules) {
    form.append(m.name, new Blob([m.content], { type: m.contentType }), m.name);
  }
  return client.req(
    {
      method: 'PUT',
      path: `/workers/scripts/${input.scriptName}`,
      body: form,
    },
    workerScriptUploadSchema,
  );
};

export const deleteScript = (
  client: CFClient,
  scriptName: string,
): Promise<Result<{ deleted: true }, CodedError>> =>
  client.req(
    { method: 'DELETE', path: `/workers/scripts/${scriptName}` },
    z.unknown().transform(() => ({ deleted: true as const })),
  );

// Scripts uploaded via the REST API have their *.workers.dev subdomain
// disabled by default. Without this call, the public preview URL returns
// Cloudflare's "There is nothing here yet" placeholder. Idempotent: a
// second POST with the same payload is a no-op.
export const enableSubdomain = (
  client: CFClient,
  scriptName: string,
): Promise<Result<{ enabled: true }, CodedError>> =>
  client.req(
    {
      method: 'POST',
      path: `/workers/scripts/${scriptName}/subdomain`,
      body: { enabled: true, previews_enabled: false },
    },
    z.unknown().transform(() => ({ enabled: true as const })),
  );
