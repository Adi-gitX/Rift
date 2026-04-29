/**
 * Bundle rewriter — turns a customer-supplied wrangler.jsonc + worker
 * modules into a Workers-Scripts upload payload scoped to this PR.
 *
 * Responsibilities:
 *   1. Map customer's binding declarations onto Raft's freshly-provisioned
 *      D1, KV, Queue, and R2-prefix handles (per-PR isolation).
 *   2. Emit DO wrapper modules per A2 — one per class in `do_classes_to_shard`.
 *   3. Inject env vars the customer code needs (R2_PREFIX, RAFT_PR_SCOPE).
 *   4. Surface unresolved bindings as warnings (does not throw).
 */
import type {
  BundleInputs,
  BundleModule,
  CustomerBinding,
  ProducedBinding,
  ResourceMap,
  RewrittenBundle,
} from './types.ts';
import { generateWrapperModules } from './wrapper-codegen.ts';

const findD1 = (resources: ResourceMap, binding: string) =>
  (resources.d1 ?? []).find((r) => r.binding === binding);
const findKv = (resources: ResourceMap, binding: string) =>
  (resources.kv ?? []).find((r) => r.binding === binding);
const findQueue = (resources: ResourceMap, binding: string) =>
  (resources.queues ?? []).find((r) => r.binding === binding);

const mapD1 = (
  cb: Extract<CustomerBinding, { type: 'd1' }>,
  resources: ResourceMap,
  warnings: string[],
): ProducedBinding => {
  const m = findD1(resources, cb.binding);
  if (!m) {
    warnings.push(`d1 binding "${cb.binding}" not provisioned — passing through customer id`);
    return { type: 'd1', name: cb.binding, id: cb.database_id };
  }
  return { type: 'd1', name: cb.binding, id: m.database_id };
};

const mapKv = (
  cb: Extract<CustomerBinding, { type: 'kv' }>,
  resources: ResourceMap,
  warnings: string[],
): ProducedBinding => {
  const m = findKv(resources, cb.binding);
  if (!m) {
    warnings.push(`kv binding "${cb.binding}" not provisioned — passing through customer id`);
    return { type: 'kv_namespace', name: cb.binding, namespace_id: cb.id };
  }
  return { type: 'kv_namespace', name: cb.binding, namespace_id: m.id };
};

const mapQueueBinding = (
  cb: Extract<CustomerBinding, { type: 'queue' }>,
  resources: ResourceMap,
  warnings: string[],
): ProducedBinding => {
  const m = findQueue(resources, cb.binding);
  if (!m) {
    warnings.push(`queue binding "${cb.binding}" not provisioned — passing through customer name`);
    return { type: 'queue', name: cb.binding, queue_name: cb.queue_name };
  }
  return { type: 'queue', name: cb.binding, queue_name: m.queue_name };
};

const mapDo = (cb: Extract<CustomerBinding, { type: 'do' }>): ProducedBinding =>
  cb.script_name === undefined
    ? { type: 'durable_object_namespace', name: cb.binding, class_name: cb.class_name }
    : {
        type: 'durable_object_namespace',
        name: cb.binding,
        class_name: cb.class_name,
        script_name: cb.script_name,
      };

const mapBinding = (
  cb: CustomerBinding,
  resources: ResourceMap,
  warnings: string[],
): ProducedBinding | null => {
  switch (cb.type) {
    case 'd1':    return mapD1(cb, resources, warnings);
    case 'kv':    return mapKv(cb, resources, warnings);
    case 'queue': return mapQueueBinding(cb, resources, warnings);
    case 'r2':
      // R2 prefix isolation is enforced via the injected R2_PREFIX env var;
      // the bucket binding stays the customer's bucket.
      return { type: 'r2_bucket', name: cb.binding, bucket_name: cb.bucket_name };
    case 'do':    return mapDo(cb);
  }
};

const injectedEnvBindings = (resources: ResourceMap, scope: string): ProducedBinding[] => {
  const out: ProducedBinding[] = [{ type: 'plain_text', name: 'RAFT_PR_SCOPE', text: scope }];
  if (resources.r2Prefix !== undefined) {
    out.push({ type: 'plain_text', name: 'R2_PREFIX', text: resources.r2Prefix });
  }
  return out;
};

export const rewriteBundle = (input: BundleInputs): RewrittenBundle => {
  const warnings: string[] = [];
  const customerBindings = input.wrangler.bindings
    .map((b) => mapBinding(b, input.resources, warnings))
    .filter((b): b is ProducedBinding => b !== null);

  const wrappers = generateWrapperModules(input.wrangler.do_classes_to_shard, input.scope);
  const modules: BundleModule[] = [...input.modules, ...wrappers];

  const bindings: ProducedBinding[] = [
    ...customerBindings,
    ...injectedEnvBindings(input.resources, input.scope),
    { type: 'plain_text', name: 'RAFT_INTERNAL_DISPATCH_SECRET', text: input.internalDispatchSecret },
  ];

  return { bindings, modules, warnings };
};

export type { BundleInputs, RewrittenBundle, CustomerWranglerSummary } from './types.ts';
