import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { upsertInstallation } from '../../../src/lib/db/installations.ts';
import { upsertRepo } from '../../../src/lib/db/repos.ts';
import {
  createPrEnvironment,
  getPrEnvironment,
  listPrEnvironmentsForRepo,
  listStalePrEnvironments,
  prEnvIdOf,
  setResourceHandles,
  transitionState,
} from '../../../src/lib/db/prEnvironments.ts';

const setupRepo = async (suffix: string): Promise<string> => {
  const installId = `inst-pe-${suffix}`;
  await upsertInstallation(env.DB, {
    id: installId,
    githubAccount: 'acme',
    githubAccountId: 1,
    accountType: 'organization',
  });
  const r = await upsertRepo(env.DB, {
    installationId: installId,
    githubRepoId: 1,
    fullName: `acme/p-${suffix}`,
    uploadTokenHash: 'h',
  });
  if (!r.ok) throw r.error;
  return r.value.id;
};

describe('pr_environments repo', () => {
  it('creates with state=pending and round-trips', async () => {
    const repoId = await setupRepo('1');
    const r = await createPrEnvironment(env.DB, { repoId, prNumber: 42, headSha: 'abc1234' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(prEnvIdOf(repoId, 42));
    expect(r.value.state).toBe('pending');
    expect(r.value.headSha).toBe('abc1234');
    expect(r.value.resources.d1DatabaseId).toBeNull();
  });

  it('createPrEnvironment is idempotent on (repo, pr)', async () => {
    const repoId = await setupRepo('2');
    await createPrEnvironment(env.DB, { repoId, prNumber: 7, headSha: 'sha1' });
    await createPrEnvironment(env.DB, { repoId, prNumber: 7, headSha: 'sha2' });
    const list = await listPrEnvironmentsForRepo(env.DB, repoId);
    if (!list.ok) throw list.error;
    const sevens = list.value.filter((p) => p.prNumber === 7);
    expect(sevens).toHaveLength(1);
    expect(sevens[0]?.headSha).toBe('sha2');
  });

  it('transitionState walks the canonical state machine', async () => {
    const repoId = await setupRepo('3');
    await createPrEnvironment(env.DB, { repoId, prNumber: 1, headSha: 's' });
    const id = prEnvIdOf(repoId, 1);
    await transitionState(env.DB, id, 'provisioning');
    await transitionState(env.DB, id, 'ready');
    const got = await getPrEnvironment(env.DB, id);
    if (!got.ok || !got.value) throw new Error('missing');
    expect(got.value.state).toBe('ready');
    expect(got.value.readyAt).not.toBeNull();
  });

  it('setResourceHandles writes resource UUIDs', async () => {
    const repoId = await setupRepo('4');
    await createPrEnvironment(env.DB, { repoId, prNumber: 11, headSha: 's' });
    const id = prEnvIdOf(repoId, 11);
    await setResourceHandles(env.DB, id, {
      d1DatabaseId: 'd1-uuid',
      kvNamespaceId: 'kv-uuid',
      workerScriptName: 'raft-x-y-pr-11',
      previewHostname: 'pr-11--acme-p4.preview.raft.dev',
    });
    const got = await getPrEnvironment(env.DB, id);
    if (!got.ok || !got.value) throw new Error('missing');
    expect(got.value.resources.d1DatabaseId).toBe('d1-uuid');
    expect(got.value.resources.kvNamespaceId).toBe('kv-uuid');
    expect(got.value.resources.workerScriptName).toBe('raft-x-y-pr-11');
    expect(got.value.previewHostname).toBe('pr-11--acme-p4.preview.raft.dev');
  });

  it('listStalePrEnvironments returns ready+old envs only', async () => {
    const repoId = await setupRepo('5');
    await createPrEnvironment(env.DB, { repoId, prNumber: 1, headSha: 's' });
    await transitionState(env.DB, prEnvIdOf(repoId, 1), 'ready');
    await env.DB.prepare(`UPDATE pr_environments SET last_activity_at = 0 WHERE id = ?`)
      .bind(prEnvIdOf(repoId, 1))
      .run();
    await createPrEnvironment(env.DB, { repoId, prNumber: 2, headSha: 's' });
    await transitionState(env.DB, prEnvIdOf(repoId, 2), 'ready');
    const r = await listStalePrEnvironments(env.DB, 1000);
    if (!r.ok) throw r.error;
    const ids = r.value.map((p) => p.id);
    expect(ids).toContain(prEnvIdOf(repoId, 1));
    expect(ids).not.toContain(prEnvIdOf(repoId, 2));
  });

  it('FK cascade: deleting installation removes repo + pr_envs', async () => {
    const repoId = await setupRepo('6');
    await createPrEnvironment(env.DB, { repoId, prNumber: 1, headSha: 's' });
    await env.DB.prepare(`PRAGMA foreign_keys = ON`).run();
    await env.DB.prepare(`DELETE FROM installations WHERE id = ?`).bind('inst-pe-6').run();
    const list = await listPrEnvironmentsForRepo(env.DB, repoId);
    if (!list.ok) throw list.error;
    expect(list.value).toHaveLength(0);
  });
});
