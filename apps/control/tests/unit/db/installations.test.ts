import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  getInstallation,
  listActiveInstallations,
  setCloudflareConnection,
  softDeleteInstallation,
  upsertInstallation,
} from '../../../src/lib/db/installations.ts';

const sample = (id: string) => ({
  id,
  githubAccount: `acct-${id}`,
  githubAccountId: Number(id) || 1,
  accountType: 'organization' as const,
});

describe('installations repo', () => {
  it('upserts and round-trips', async () => {
    const r = await upsertInstallation(env.DB, sample('100'));
    expect(r.ok).toBe(true);
    const got = await getInstallation(env.DB, '100');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value?.githubAccount).toBe('acct-100');
    expect(got.value?.active).toBe(true);
    expect(got.value?.plan).toBe('free');
    expect(got.value?.config).toEqual({});
  });

  it('upsert is idempotent and reactivates', async () => {
    await upsertInstallation(env.DB, sample('200'));
    await softDeleteInstallation(env.DB, '200');
    const beforeReupsert = await getInstallation(env.DB, '200');
    expect(beforeReupsert.ok && beforeReupsert.value?.active).toBe(false);
    await upsertInstallation(env.DB, sample('200'));
    const after = await getInstallation(env.DB, '200');
    expect(after.ok && after.value?.active).toBe(true);
    expect(after.ok && after.value?.uninstalledAt).toBeNull();
  });

  it('lists only active installations', async () => {
    await upsertInstallation(env.DB, sample('300'));
    await upsertInstallation(env.DB, sample('301'));
    await softDeleteInstallation(env.DB, '301');
    const r = await listActiveInstallations(env.DB);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.map((i) => i.id);
    expect(ids).toContain('300');
    expect(ids).not.toContain('301');
  });

  it('records cloudflare connection', async () => {
    await upsertInstallation(env.DB, sample('400'));
    const r = await setCloudflareConnection(env.DB, '400', 'cf-acct', 'sec-id');
    expect(r.ok).toBe(true);
    const got = await getInstallation(env.DB, '400');
    expect(got.ok && got.value?.cloudflareAccountId).toBe('cf-acct');
    expect(got.ok && got.value?.cloudflareTokenSecretId).toBe('sec-id');
  });
});
