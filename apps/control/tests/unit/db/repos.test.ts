import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { upsertInstallation } from '../../../src/lib/db/installations.ts';
import {
  listReposForInstallation,
  repoIdOf,
  rotateUploadTokenHash,
  setBaseResources,
  upsertRepo,
} from '../../../src/lib/db/repos.ts';

const installation = { id: 'inst-repos', githubAccount: 'acme', githubAccountId: 7, accountType: 'organization' as const };

describe('repos repo', () => {
  it('upserts and round-trips with upload_token_hash', async () => {
    await upsertInstallation(env.DB, installation);
    const r = await upsertRepo(env.DB, {
      installationId: 'inst-repos',
      githubRepoId: 1234,
      fullName: 'acme/api',
      uploadTokenHash: 'hash-v1',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.id).toBe(repoIdOf('inst-repos', 'acme/api'));
    expect(r.value.uploadTokenHash).toBe('hash-v1');
    expect(r.value.defaultBranch).toBe('main');
    expect(r.value.doClassNames).toEqual([]);
  });

  it('upsert preserves upload_token_hash on second sight', async () => {
    await upsertInstallation(env.DB, installation);
    await upsertRepo(env.DB, {
      installationId: 'inst-repos',
      githubRepoId: 1234,
      fullName: 'acme/api2',
      uploadTokenHash: 'original',
    });
    await upsertRepo(env.DB, {
      installationId: 'inst-repos',
      githubRepoId: 1234,
      fullName: 'acme/api2',
      uploadTokenHash: 'should-not-overwrite',
    });
    const list = await listReposForInstallation(env.DB, 'inst-repos');
    if (!list.ok) throw list.error;
    const found = list.value.find((r) => r.fullName === 'acme/api2');
    expect(found?.uploadTokenHash).toBe('original');
  });

  it('rotateUploadTokenHash replaces the hash', async () => {
    await upsertInstallation(env.DB, installation);
    const created = await upsertRepo(env.DB, {
      installationId: 'inst-repos',
      githubRepoId: 9,
      fullName: 'acme/rotate',
      uploadTokenHash: 'old',
    });
    if (!created.ok) throw created.error;
    await rotateUploadTokenHash(env.DB, created.value.id, 'new');
    const list = await listReposForInstallation(env.DB, 'inst-repos');
    if (!list.ok) throw list.error;
    expect(list.value.find((r) => r.fullName === 'acme/rotate')?.uploadTokenHash).toBe('new');
  });

  it('setBaseResources merges discovered base bindings', async () => {
    await upsertInstallation(env.DB, installation);
    const created = await upsertRepo(env.DB, {
      installationId: 'inst-repos',
      githubRepoId: 9,
      fullName: 'acme/base',
      uploadTokenHash: 'h',
    });
    if (!created.ok) throw created.error;
    await setBaseResources(env.DB, created.value.id, {
      baseD1Id: 'd1-uuid',
      doClassNames: ['ChatRoom', 'Counter'],
    });
    const list = await listReposForInstallation(env.DB, 'inst-repos');
    if (!list.ok) throw list.error;
    const found = list.value.find((r) => r.fullName === 'acme/base');
    expect(found?.baseD1Id).toBe('d1-uuid');
    expect(found?.doClassNames).toEqual(['ChatRoom', 'Counter']);
  });
});
