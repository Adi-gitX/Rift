/**
 * Inputs and outputs of the bundle rewriter.
 *
 * Customers ship Raft a worker bundle: their `wrangler.jsonc` (parsed) plus
 * the bundled JavaScript module(s). Raft rewrites the binding identifiers to
 * point at this PR's isolated resources and emits per-DO-class wrapper modules
 * (PRD amendment A2) that the customer's code imports to get
 * idFromName-prefixing for free.
 */

export interface CustomerBindingD1 {
  type: 'd1';
  binding: string;
  database_id: string;
  database_name?: string;
}
export interface CustomerBindingKv {
  type: 'kv';
  binding: string;
  id: string;
}
export interface CustomerBindingQueue {
  type: 'queue';
  binding: string;
  queue_name: string;
}
export interface CustomerBindingR2 {
  type: 'r2';
  binding: string;
  bucket_name: string;
}
export interface CustomerBindingDoNs {
  type: 'do';
  binding: string;
  class_name: string;
  script_name?: string;
}

export type CustomerBinding =
  | CustomerBindingD1
  | CustomerBindingKv
  | CustomerBindingQueue
  | CustomerBindingR2
  | CustomerBindingDoNs;

export interface CustomerWranglerSummary {
  main_module: string;
  compatibility_date: string;
  compatibility_flags?: string[];
  bindings: CustomerBinding[];
  /** DO class names the customer wants Raft to shard per PR (A2). */
  do_classes_to_shard: string[];
}

export interface BundleModule {
  name: string;
  content: string | Uint8Array;
  contentType: string;
}

export interface BundleInputs {
  wrangler: CustomerWranglerSummary;
  modules: BundleModule[];
  /** Per-PR isolation handles supplied by the provisioner. */
  resources: ResourceMap;
  /** Per-PR scope key, used as DO name prefix (e.g. "pr-42"). */
  scope: string;
  /** Internal shared secret the dispatcher signs requests with. */
  internalDispatchSecret: string;
}

export interface ResourceMap {
  d1?: { binding: string; database_id: string; database_name: string }[];
  kv?: { binding: string; id: string; title: string }[];
  queues?: { binding: string; queue_name: string }[];
  r2Prefix?: string;
}

export interface RewrittenBundle {
  bindings: ProducedBinding[];
  modules: BundleModule[];
  warnings: string[];
}

/** Cloudflare Workers script-upload bindings (raft uses the v4 REST shape). */
export type ProducedBinding =
  | { type: 'd1'; name: string; id: string }
  | { type: 'kv_namespace'; name: string; namespace_id: string }
  | { type: 'queue'; name: string; queue_name: string }
  | { type: 'r2_bucket'; name: string; bucket_name: string }
  | { type: 'plain_text'; name: string; text: string }
  | { type: 'durable_object_namespace'; name: string; class_name: string; script_name?: string };
