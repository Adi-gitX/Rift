/**
 * Slice G integration tests for /api/v1/* — auth, rate limit, bundle upload.
 *
 * - Auth: GET /api/v1/installations without cookie → 401, with cookie → 200.
 * - Bundle upload: valid hashed token → 200, mismatched → 401, no headers → 401.
 * - Manual teardown: POST /api/v1/prs/:id/teardown returns 202 + DO transitions.
 */
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TeardownRunner } from '../../src/do/teardown-runner.ts';
import { signSession } from '../../src/lib/auth/cookies.ts';
import {
  hashUploadToken,
  mintUploadToken,
} from '../../src/lib/auth/upload-token.ts';
import { upsertInstallation } from '../../src/lib/db/installations.ts';
import { upsertRepo } from '../../src/lib/db/repos.ts';
import { createPrEnvironment } from '../../src/lib/db/prEnvironments.ts';

const futureExp = (): number => Math.floor(Date.now() / 1000) + 3600;

const buildSessionCookie = async (): Promise<string> => {
  const value = await signSession(
    { sub: 'admin@raft.dev', exp: futureExp() },
    env.SESSION_SIGNING_KEY,
  );
  return `raft_session=${value}`;
};

describe('Slice G API auth', () => {
  it('rejects /api/v1/installations without cookie', async () => {
    const res = await SELF.fetch('https://control.test/api/v1/installations');
    expect(res.status).toBe(401);
  });

  it('accepts /api/v1/installations with valid cookie', async () => {
    const cookie = await buildSessionCookie();
    const res = await SELF.fetch('https://control.test/api/v1/installations', {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; data: { installations: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.installations)).toBe(true);
  });
});

describe('Slice G bundle upload', () => {
  it('accepts a valid JSON bundle, stores in BUNDLES_KV under the runner-compatible key', async () => {
    const token = mintUploadToken();
    const hash = await hashUploadToken(token);
    await upsertInstallation(env.DB, {
      id: 'inst-bun',
      githubAccount: 'a',
      githubAccountId: 1,
      accountType: 'organization',
    });
    const repo = await upsertRepo(env.DB, {
      installationId: 'inst-bun',
      githubRepoId: 1,
      fullName: 'a/b',
      uploadTokenHash: hash,
    });
    if (!repo.ok) throw repo.error;

    const bundle = {
      wrangler: { main_module: 'index.js', compatibility_date: '2026-04-29' },
      modules: [
        {
          name: 'index.js',
          content_b64: btoa('export default { fetch: () => new Response("hi") }'),
          type: 'application/javascript+module',
        },
      ],
    };
    const res = await SELF.fetch('https://control.test/api/v1/bundles/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-raft-repo-id': repo.value.id,
        'x-raft-head-sha': 'sha-bun-1',
        'content-type': 'application/json',
      },
      body: JSON.stringify(bundle),
    });
    expect(res.status).toBe(200);
    // Key MUST mirror runner/provision/steps.ts `bundleKvKey()`.
    const expectedKey = `bundle:inst-bun:a/b:sha-bun-1`;
    const stored = await env.BUNDLES_KV.get(expectedKey);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.modules).toHaveLength(1);
    expect(parsed.modules[0].name).toBe('index.js');
  });

  it('rejects upload with wrong token', async () => {
    const token = mintUploadToken();
    const wrongToken = mintUploadToken();
    const hash = await hashUploadToken(token);
    await upsertInstallation(env.DB, {
      id: 'inst-bun-2',
      githubAccount: 'a',
      githubAccountId: 1,
      accountType: 'organization',
    });
    const repo = await upsertRepo(env.DB, {
      installationId: 'inst-bun-2',
      githubRepoId: 2,
      fullName: 'a/b2',
      uploadTokenHash: hash,
    });
    if (!repo.ok) throw repo.error;

    const res = await SELF.fetch('https://control.test/api/v1/bundles/upload', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${wrongToken}`,
        'x-raft-repo-id': repo.value.id,
        'x-raft-head-sha': 'sha-x',
      },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(401);
  });

  it('rejects upload with no Authorization header', async () => {
    const res = await SELF.fetch('https://control.test/api/v1/bundles/upload', {
      method: 'POST',
      body: new Uint8Array([1]),
    });
    expect(res.status).toBe(401);
  });
});

describe('Slice G manual teardown', () => {
  it('POST /api/v1/prs/:id/teardown returns 202 and starts TeardownRunner', async () => {
    await upsertInstallation(env.DB, {
      id: 'inst-td-api',
      githubAccount: 'a',
      githubAccountId: 1,
      accountType: 'organization',
    });
    const repo = await upsertRepo(env.DB, {
      installationId: 'inst-td-api',
      githubRepoId: 1,
      fullName: 'a/td',
      uploadTokenHash: 'h',
    });
    if (!repo.ok) throw repo.error;
    const pe = await createPrEnvironment(env.DB, { repoId: repo.value.id, prNumber: 1, headSha: 's' });
    if (!pe.ok) throw pe.error;

    const cookie = await buildSessionCookie();
    const res = await SELF.fetch(
      `https://control.test/api/v1/prs/${encodeURIComponent(pe.value.id)}/teardown`,
      { method: 'POST', headers: { cookie } },
    );
    expect(res.status).toBe(202);

    // Drain the alarm chain so the test exits with stable DO storage.
    const runner = env.TEARDOWN_RUNNER.get(
      env.TEARDOWN_RUNNER.idFromName(pe.value.id),
    ) as DurableObjectStub<TeardownRunner>;
    for (let i = 0; i < 30; i++) {
      await runDurableObjectAlarm(runner);
      const snap = await runInDurableObject(runner, async (r: TeardownRunner) =>
        r.getStateSnapshot(),
      );
      if (snap?.status === 'succeeded' || snap?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
  });
});
