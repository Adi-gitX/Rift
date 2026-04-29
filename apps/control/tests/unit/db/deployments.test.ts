import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { upsertInstallation } from '../../../src/lib/db/installations.ts';
import { upsertRepo } from '../../../src/lib/db/repos.ts';
import { createPrEnvironment } from '../../../src/lib/db/prEnvironments.ts';
import {
  createDeployment,
  getDeployment,
  listDeploymentsForPrEnv,
  updateDeploymentStatus,
} from '../../../src/lib/db/deployments.ts';
import { ulid } from '../../../src/lib/ids.ts';

const setupPrEnv = async (suffix: string): Promise<string> => {
  const installId = `inst-dep-${suffix}`;
  await upsertInstallation(env.DB, {
    id: installId,
    githubAccount: 'a',
    githubAccountId: 1,
    accountType: 'organization',
  });
  const repo = await upsertRepo(env.DB, {
    installationId: installId,
    githubRepoId: 1,
    fullName: `a/p-${suffix}`,
    uploadTokenHash: 'h',
  });
  if (!repo.ok) throw repo.error;
  const pe = await createPrEnvironment(env.DB, {
    repoId: repo.value.id,
    prNumber: 1,
    headSha: 's',
  });
  if (!pe.ok) throw pe.error;
  return pe.value.id;
};

describe('deployments repo', () => {
  it('creates queued deployment and updates to succeeded', async () => {
    const prEnvId = await setupPrEnv('1');
    const id = ulid();
    const created = await createDeployment(env.DB, {
      id,
      prEnvId,
      headSha: 'sha-abc',
      bundleR2Key: `bundles/${id}.zip`,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.status).toBe('queued');
    expect(created.value.finishedAt).toBeNull();

    const upd = await updateDeploymentStatus(env.DB, id, 'succeeded', { durationMs: 1234 });
    expect(upd.ok).toBe(true);
    const got = await getDeployment(env.DB, id);
    if (!got.ok || !got.value) throw new Error('missing');
    expect(got.value.status).toBe('succeeded');
    expect(got.value.durationMs).toBe(1234);
    expect(got.value.finishedAt).not.toBeNull();
  });

  it('lists deployments newest first', async () => {
    const prEnvId = await setupPrEnv('2');
    const id1 = ulid(1000);
    const id2 = ulid(2000);
    await createDeployment(env.DB, { id: id1, prEnvId, headSha: 'a', bundleR2Key: 'k1', startedAt: 100 });
    await createDeployment(env.DB, { id: id2, prEnvId, headSha: 'b', bundleR2Key: 'k2', startedAt: 200 });
    const r = await listDeploymentsForPrEnv(env.DB, prEnvId);
    if (!r.ok) throw r.error;
    expect(r.value).toHaveLength(2);
    expect(r.value[0]?.headSha).toBe('b');
  });
});
