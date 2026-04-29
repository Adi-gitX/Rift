import { describe, expect, it } from 'vitest';
import { rewriteBundle } from '../../../../src/lib/bundle-rewriter/index.ts';
import type { CustomerWranglerSummary } from '../../../../src/lib/bundle-rewriter/types.ts';

const fixture: CustomerWranglerSummary = {
  main_module: 'worker.js',
  compatibility_date: '2026-04-29',
  compatibility_flags: ['nodejs_compat'],
  bindings: [
    { type: 'd1', binding: 'DB', database_id: 'orig-d1', database_name: 'app' },
    { type: 'kv', binding: 'KV', id: 'orig-kv' },
    { type: 'queue', binding: 'JOBS', queue_name: 'orig-q' },
    { type: 'r2', binding: 'BUCKET', bucket_name: 'app-bucket' },
    { type: 'do', binding: 'CHAT', class_name: 'ChatRoom' },
    { type: 'do', binding: 'CTR', class_name: 'Counter' },
  ],
  do_classes_to_shard: ['ChatRoom', 'Counter'],
};

describe('bundle-rewriter', () => {
  it('swaps D1, KV, and Queue binding ids onto provisioned resources', () => {
    const r = rewriteBundle({
      wrangler: fixture,
      modules: [{ name: 'worker.js', content: 'export default {}', contentType: 'application/javascript+module' }],
      resources: {
        d1: [{ binding: 'DB', database_id: 'pr-d1-uuid', database_name: 'app-pr-1' }],
        kv: [{ binding: 'KV', id: 'pr-kv-id', title: 'app-kv-pr-1' }],
        queues: [{ binding: 'JOBS', queue_name: 'app-q-pr-1' }],
        r2Prefix: 'tenants/inst/app/pr-1/',
      },
      scope: 'pr-1',
      internalDispatchSecret: 'sec',
    });
    const d1 = r.bindings.find((b) => b.type === 'd1');
    const kv = r.bindings.find((b) => b.type === 'kv_namespace');
    const queue = r.bindings.find((b) => b.type === 'queue');
    expect(d1).toEqual({ type: 'd1', name: 'DB', id: 'pr-d1-uuid' });
    expect(kv).toEqual({ type: 'kv_namespace', name: 'KV', namespace_id: 'pr-kv-id' });
    expect(queue).toEqual({ type: 'queue', name: 'JOBS', queue_name: 'app-q-pr-1' });
  });

  it('emits one wrapper module per DO class to shard', () => {
    const r = rewriteBundle({
      wrangler: fixture,
      modules: [{ name: 'worker.js', content: 'x', contentType: 'application/javascript+module' }],
      resources: {},
      scope: 'pr-7',
      internalDispatchSecret: 'sec',
    });
    const wrappers = r.modules.filter((m) => m.name.startsWith('__raft_wrappers__/'));
    expect(wrappers.map((w) => w.name).sort()).toEqual([
      '__raft_wrappers__/ChatRoom.js',
      '__raft_wrappers__/Counter.js',
    ]);
    const wrapperSrc = String(wrappers[0]?.content);
    expect(wrapperSrc).toContain('"pr-7"');
    expect(wrapperSrc).toMatch(/scoped\(name\)/);
  });

  it('injects RAFT_PR_SCOPE, R2_PREFIX, and INTERNAL_DISPATCH_SECRET as plain_text bindings', () => {
    const r = rewriteBundle({
      wrangler: fixture,
      modules: [{ name: 'worker.js', content: 'x', contentType: 'application/javascript+module' }],
      resources: { r2Prefix: 'tenants/x/y/pr-1/' },
      scope: 'pr-1',
      internalDispatchSecret: 'super-secret',
    });
    const plain = r.bindings.filter((b) => b.type === 'plain_text');
    const names = plain.map((b) => b.name).sort();
    expect(names).toEqual(['R2_PREFIX', 'RAFT_INTERNAL_DISPATCH_SECRET', 'RAFT_PR_SCOPE']);
  });

  it('warns (does not throw) when a customer binding is not provisioned', () => {
    const r = rewriteBundle({
      wrangler: fixture,
      modules: [],
      resources: { d1: [], kv: [], queues: [] },
      scope: 'pr-1',
      internalDispatchSecret: 'sec',
    });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toMatch(/d1 binding "DB" not provisioned/);
  });
});
