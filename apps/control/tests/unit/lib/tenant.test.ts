import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decryptString, encryptString } from '../../../src/lib/crypto/aes.ts';
import {
  publicInstallation,
  setCloudflareConnection,
  setInstallationConfig,
  upsertInstallation,
  getInstallation,
  clearCloudflareConnection,
} from '../../../src/lib/db/installations.ts';
import { resolveCloudflareCredentials, sealToken } from '../../../src/lib/tenant.ts';
import { chooseForkMode, forkCapBytes } from '../../../src/lib/d1-migrations/fork-mode.ts';

describe('aes', () => {
  it('round-trips and rejects a wrong key', async () => {
    const ct = await encryptString('k1', 'cfut_secret');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(ct).not.toContain('cfut_secret');
    expect(await decryptString('k1', ct)).toBe('cfut_secret');
    await expect(decryptString('k2', ct)).rejects.toThrow();
    // Fresh IV every time.
    expect(await encryptString('k1', 'x')).not.toBe(await encryptString('k1', 'x'));
  });
});

describe('resolveCloudflareCredentials', () => {
  it('falls back to the shared token, then uses the installation token once connected', async () => {
    await upsertInstallation(env.DB, {
      id: 'tenant-1',
      githubAccount: 'acme',
      githubAccountId: 9,
      accountType: 'organization',
    });
    const shared = await resolveCloudflareCredentials(env, 'tenant-1');
    expect(shared).toMatchObject({ source: 'shared', token: env.CF_API_TOKEN });

    const sealed = await sealToken(env, 'cfut_tenant_token_abcdefghijklmnop');
    await setCloudflareConnection(env.DB, 'tenant-1', 'a'.repeat(32), sealed);
    await setInstallationConfig(env.DB, 'tenant-1', { workersSubdomain: 'acme.workers.dev' });
    const own = await resolveCloudflareCredentials(env, 'tenant-1');
    expect(own).toEqual({
      source: 'installation',
      accountId: 'a'.repeat(32),
      token: 'cfut_tenant_token_abcdefghijklmnop',
      workersSubdomain: 'acme.workers.dev',
    });

    const row = await getInstallation(env.DB, 'tenant-1');
    const pub = publicInstallation(row.ok && row.value ? row.value : (null as never));
    expect(pub.cloudflareConnected).toBe(true);
    expect(JSON.stringify(pub)).not.toContain('cfut_');

    await clearCloudflareConnection(env.DB, 'tenant-1');
    expect((await resolveCloudflareCredentials(env, 'tenant-1')).source).toBe('shared');
  });

  it('unknown installations get the shared credentials', async () => {
    expect((await resolveCloudflareCredentials(env, 'nope')).source).toBe('shared');
  });
});

describe('fork mode', () => {
  it('full under the cap, schema-only above; repo config overrides the cap', () => {
    expect(forkCapBytes(undefined)).toBe(100 * 1024 * 1024);
    expect(forkCapBytes({ max_d1_export_size_mb: 5 })).toBe(5 * 1024 * 1024);
    expect(chooseForkMode(undefined, 100)).toBe('full');
    expect(chooseForkMode(99, 100)).toBe('full');
    expect(chooseForkMode(101, 100)).toBe('schema-only');
  });
});
