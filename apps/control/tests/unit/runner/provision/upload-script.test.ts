/**
 * Verifies the in-step propagation retry inside `uploadScript`:
 *  - CF returns 400 with body containing `"code":10181` (D1 binding not
 *    found yet) on the first two attempts.
 *  - Third attempt returns 200 OK.
 *  - The step ultimately succeeds without throwing.
 *
 * Also asserts the "permanent" failure path: a non-propagation 400 is
 * thrown immediately, no retry.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { uploadScript, type StepContext } from '../../../../src/runner/provision/steps.ts';
import { Logger } from '../../../../src/lib/logger.ts';
import { upsertInstallation } from '../../../../src/lib/db/installations.ts';
import { upsertRepo } from '../../../../src/lib/db/repos.ts';
import { createPrEnvironment } from '../../../../src/lib/db/prEnvironments.ts';

const cfBindingMissing = (code: string, msg: string): Response =>
  new Response(JSON.stringify({ errors: [{ code: Number(code), message: msg }] }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const seedAndContext = async (suffix: string): Promise<StepContext> => {
  await upsertInstallation(env.DB, {
    id: `inst-up-${suffix}`,
    githubAccount: 'a',
    githubAccountId: 1,
    accountType: 'organization',
  });
  const repo = await upsertRepo(env.DB, {
    installationId: `inst-up-${suffix}`,
    githubRepoId: 1,
    fullName: `a/p-up-${suffix}`,
    uploadTokenHash: 'h',
  });
  if (!repo.ok) throw repo.error;
  const pe = await createPrEnvironment(env.DB, { repoId: repo.value.id, prNumber: 1, headSha: 'sha' });
  if (!pe.ok) throw pe.error;
  return {
    env,
    params: {
      installationId: `inst-up-${suffix}`,
      repoFullName: `a/p-up-${suffix}`,
      prNumber: 1,
      headSha: 'sha',
      baseSha: 'b',
      baseBranch: 'main',
      triggerActor: 'alice',
    },
    prEnvId: pe.value.id,
    scope: 'pr-1--upsuffix',
    scriptName: 'raft-up-test-pr-1',
    previewHostname: 'http://example/preview',
    log: new Logger({ component: 'test' }),
    fetcher: globalThis.fetch.bind(globalThis),
    propagationDelayMs: 0,
    prior: {
      'load-config': {
        wrangler: { main_module: 'worker.js', compatibility_date: '2026-04-29', bindings: [], do_classes_to_shard: [] },
        bundleR2Key: 'k',
      },
      'provision-resources': {
        d1: { binding: 'DB', database_id: 'd1-uuid', database_name: 'mock-d1' },
        kv: { binding: 'KV', id: 'kv-id', title: 'mock-kv' },
        queue: { binding: 'QUEUE', queue_name: 'mock-q', queue_id: 'q-uuid' },
        r2Prefix: 'tenants/x/y/pr-1/',
      },
    },
  };
};

describe('uploadScript — propagation retry', () => {
  it('retries on CF code 10181 (D1 binding not found yet) then succeeds', async () => {
    const ctx = await seedAndContext('a');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfBindingMissing('10181', "D1 binding 'DB' references database 'X' which was not found"))
      .mockResolvedValueOnce(cfBindingMissing('10181', 'still propagating'))
      .mockResolvedValueOnce(cfOk({ id: 'raft-up-test-pr-1', etag: 'e1' }))
      // After successful upload, uploadScript calls enableSubdomain.
      .mockResolvedValueOnce(cfOk({ enabled: true }));
    ctx.fetcher = fetcher as unknown as typeof fetch;

    const r = await uploadScript(ctx);
    expect(r.scriptId).toBe('raft-up-test-pr-1');
    // 3 upload attempts + 1 subdomain enable.
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('retries on CF code 10041 (KV namespace not found) then succeeds', async () => {
    const ctx = await seedAndContext('b');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfBindingMissing('10041', "KV namespace 'X' not found"))
      .mockResolvedValueOnce(cfOk({ id: 'raft-up-test-pr-1', etag: 'e1' }))
      .mockResolvedValueOnce(cfOk({ enabled: true }));
    ctx.fetcher = fetcher as unknown as typeof fetch;

    const r = await uploadScript(ctx);
    expect(r.scriptId).toBe('raft-up-test-pr-1');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on non-propagation 400 — fails immediately', async () => {
    const ctx = await seedAndContext('c');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfBindingMissing('10001', 'invalid script body'));
    ctx.fetcher = fetcher as unknown as typeof fetch;

    await expect(uploadScript(ctx)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('exhausts after 5 propagation attempts', async () => {
    const ctx = await seedAndContext('d');
    const fetcher = vi.fn();
    for (let i = 0; i < 6; i++) {
      fetcher.mockResolvedValueOnce(cfBindingMissing('10181', 'still propagating'));
    }
    ctx.fetcher = fetcher as unknown as typeof fetch;

    await expect(uploadScript(ctx)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });
});
