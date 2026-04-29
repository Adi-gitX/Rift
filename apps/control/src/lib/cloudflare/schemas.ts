/**
 * Zod schemas for the subset of the Cloudflare API Raft uses.
 * The official API envelope is `{ success, errors, messages, result }`.
 */
import { z } from 'zod';

export const cfEnvelope = <T extends z.ZodTypeAny>(result: T) =>
  z.object({
    success: z.boolean(),
    errors: z
      .array(z.object({ code: z.number().int().optional(), message: z.string() }).passthrough())
      .default([]),
    messages: z.array(z.unknown()).default([]),
    result,
  });

// ── D1 ──────────────────────────────────────────────────────────────────────
export const d1DatabaseSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  created_at: z.string().optional(),
});
export type D1DatabaseShape = z.infer<typeof d1DatabaseSchema>;

export const d1ExportPollSchema = z.object({
  status: z.enum(['active', 'complete', 'error']),
  at_bookmark: z.string().optional(),
  signed_url: z.string().url().optional(),
  filename: z.string().optional(),
  error: z.string().optional(),
});
export type D1ExportPollShape = z.infer<typeof d1ExportPollSchema>;

export const d1ImportInitSchema = z.object({
  upload_url: z.string().url(),
  filename: z.string(),
  at_bookmark: z.string().optional(),
});
export type D1ImportInitShape = z.infer<typeof d1ImportInitSchema>;

export const d1ImportPollSchema = z.object({
  status: z.enum(['active', 'complete', 'error']),
  at_bookmark: z.string().optional(),
  error: z.string().optional(),
});
export type D1ImportPollShape = z.infer<typeof d1ImportPollSchema>;

// ── KV ──────────────────────────────────────────────────────────────────────
export const kvNamespaceSchema = z.object({
  id: z.string(),
  title: z.string(),
});
export type KvNamespaceShape = z.infer<typeof kvNamespaceSchema>;

// ── Queues ──────────────────────────────────────────────────────────────────
export const queueSchema = z.object({
  queue_id: z.string(),
  queue_name: z.string(),
  created_on: z.string().optional(),
});
export type QueueShape = z.infer<typeof queueSchema>;

// ── Workers Scripts (free-tier path: not WfP) ───────────────────────────────
export const workerScriptUploadSchema = z.object({
  id: z.string(),
  etag: z.string().optional(),
  startup_time_ms: z.number().int().optional(),
});
export type WorkerScriptUploadShape = z.infer<typeof workerScriptUploadSchema>;
