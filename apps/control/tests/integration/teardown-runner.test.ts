/**
 * Slice E integration test: TeardownRunner DO walks all 9 steps via alarms,
 * deletes the worker script + D1 + KV + Queue + R2 prefix + ROUTES KV entry,
 * lands the PR env in `torn_down`, and is idempotent under replay (running
 * teardown twice yields the same end state, no double-delete error path).
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProvisionRunner } from '../../src/do/provision-runner.ts';
import type { TeardownRunner } from '../../src/do/teardown-runner.ts';
import type { ProvisionRunnerState } from '../../src/runner/provision/state.ts';
import type { TeardownRunnerState } from '../../src/runner/teardown/state.ts';
import { upsertInstallation } from '../../src/lib/db/installations.ts';
import { upsertRepo } from '../../src/lib/db/repos.ts';
import { createPrEnvironment } from '../../src/lib/db/prEnvironments.ts';
import { bundleKvKey } from '../../src/lib/bundle-key.ts';

const seedAndProvision = async (
  suffix: string,
): Promise<{ prEnvId: string; installationId: string }> => {
  const installationId = `inst-td-${suffix}`;
  await upsertInstallation(env.DB, {
    id: installationId,
    githubAccount: 'a',
    githubAccountId: 1,
    accountType: 'organization',
  });
  const repo = await upsertRepo(env.DB, {
    installationId,
    githubRepoId: 1,
    fullName: `a/p-td-${suffix}`,
    uploadTokenHash: 'h',
  });
  if (!repo.ok) throw repo.error;
  const pe = await createPrEnvironment(env.DB, {
    repoId: repo.value.id,
    prNumber: 1,
    headSha: 'sha',
  });
  if (!pe.ok) throw pe.error;
  const prEnvId = pe.value.id;

  const provStub = env.PROVISION_RUNNER.get(
    env.PROVISION_RUNNER.idFromName(prEnvId),
  ) as DurableObjectStub<ProvisionRunner>;
  const initial: ProvisionRunnerState = {
    prEnvId,
    installationId,
    scope: 'pr-1',
    scriptName: `raft-td${suffix}-p-pr-1`,
    previewHostname: `pr-1--td-${suffix}.preview.raft.test`,
    params: {
      installationId,
      repoFullName: `a/p-td-${suffix}`,
      prNumber: 1,
      headSha: 'sha',
      baseSha: 'b',
      baseBranch: 'main',
      triggerActor: 'alice',
    },
    cursor: 0,
    status: 'pending',
    attempts: 0,
    startedAt: 0,
    errorHistory: [],
  };
  await provStub.start(initial);
  for (let i = 0; i < 30; i++) {
    await runDurableObjectAlarm(provStub);
    const snap = await runInDurableObject(provStub, async (r: ProvisionRunner) =>
      r.getStateSnapshot(),
    );
    if (snap?.status === 'succeeded' || snap?.status === 'failed') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { prEnvId, installationId };
};

const driveTeardown = async (
  stub: DurableObjectStub<TeardownRunner>,
  maxIters = 30,
): Promise<TeardownRunnerState | null> => {
  for (let i = 0; i < maxIters; i++) {
    await runDurableObjectAlarm(stub);
    const snap = await runInDurableObject(stub, async (r: TeardownRunner) => r.getStateSnapshot());
    if (snap?.status === 'succeeded' || snap?.status === 'failed') return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  return runInDurableObject(stub, async (r: TeardownRunner) => r.getStateSnapshot());
};

describe('Slice E TeardownRunner — alarm-driven 9-step destructor', () => {
  it('walks to torn_down, clears the route, and is idempotent under replay', async () => {
    const { prEnvId, installationId } = await seedAndProvision('a');
    const tdStub = env.TEARDOWN_RUNNER.get(
      env.TEARDOWN_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<TeardownRunner>;

    const initial: TeardownRunnerState = {
      prEnvId,
      installationId,
      reason: 'pr_closed',
      cursor: 0,
      status: 'pending',
      attempts: 0,
      startedAt: 0,
      errorHistory: [],
    };
    await tdStub.start(initial);
    const final1 = await driveTeardown(tdStub);
    expect(final1?.status).toBe('succeeded');

    const row = await env.DB.prepare(`SELECT state FROM pr_environments WHERE id = ?`)
      .bind(prEnvId)
      .first<{ state: string }>();
    expect(row?.state).toBe('torn_down');

    const route = await env.ROUTES.get('route:pr-1');
    expect(route).toBeNull();

    // Idempotency: re-trigger teardown. Steps are cached in DO storage; the
    // second pass walks the cursor without re-calling external APIs.
    await tdStub.start({ ...initial, cursor: 0, attempts: 0 });
    const final2 = await driveTeardown(tdStub);
    expect(final2?.status).toBe('succeeded');
    expect(final2?.errorHistory).toEqual([]);
  });

  it('purge-bundle-kv deletes the uploaded bundle under its real key', async () => {
    const { prEnvId, installationId } = await seedAndProvision('k');
    const key = bundleKvKey(installationId, 'a/p-td-k', 'sha');
    await env.BUNDLES_KV.put(key, '{"modules":[]}');
    const tdStub = env.TEARDOWN_RUNNER.get(
      env.TEARDOWN_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<TeardownRunner>;
    await tdStub.start({
      prEnvId,
      installationId,
      reason: 'manual',
      cursor: 0,
      status: 'pending',
      attempts: 0,
      startedAt: 0,
      errorHistory: [],
    });
    expect((await driveTeardown(tdStub))?.status).toBe('succeeded');
    expect(await env.BUNDLES_KV.get(key)).toBeNull();
    const results = await runInDurableObject(tdStub, async (r: TeardownRunner) =>
      r.getStepResults(),
    );
    expect(results['purge-bundle-kv']).toEqual({ deleted: 1, key });
  });
});

describe('ProvisionRunner failure → compensating teardown', () => {
  it('a NonRetryable step failure schedules a TeardownRunner with reason=failed', async () => {
    const installationId = 'inst-comp';
    await upsertInstallation(env.DB, {
      id: installationId,
      githubAccount: 'a',
      githubAccountId: 1,
      accountType: 'organization',
    });
    const repo = await upsertRepo(env.DB, {
      installationId,
      githubRepoId: 1,
      fullName: 'a/comp',
      uploadTokenHash: 'h',
    });
    if (!repo.ok) throw repo.error;
    const pe = await createPrEnvironment(env.DB, {
      repoId: repo.value.id,
      prNumber: 1,
      headSha: 'sha',
    });
    if (!pe.ok) throw pe.error;
    const prEnvId = pe.value.id;
    const provStub = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;
    // Invalid script name (spaces, punctuation) → upload-script throws NonRetryableError.
    await provStub.start({
      prEnvId,
      installationId,
      scope: 'pr-1--acomp',
      scriptName: 'bad script name!',
      previewHostname: 'https://raft-dispatcher.raft-test.workers.dev/pr-1--acomp',
      params: {
        installationId,
        repoFullName: 'a/comp',
        prNumber: 1,
        headSha: 'sha',
        baseSha: 'b',
        baseBranch: 'main',
        triggerActor: 'alice',
      },
      cursor: 0,
      status: 'pending',
      attempts: 0,
      startedAt: 0,
      errorHistory: [],
    });
    let provSnap: ProvisionRunnerState | null = null;
    for (let i = 0; i < 30; i++) {
      await runDurableObjectAlarm(provStub);
      provSnap = await runInDurableObject(provStub, async (r: ProvisionRunner) =>
        r.getStateSnapshot(),
      );
      if (provSnap?.status === 'succeeded' || provSnap?.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(provSnap?.status).toBe('failed');

    const tdStub = env.TEARDOWN_RUNNER.get(
      env.TEARDOWN_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<TeardownRunner>;
    const tdSnap = await driveTeardown(tdStub);
    expect(tdSnap?.reason).toBe('failed');
    expect(tdSnap?.status).toBe('succeeded');
    const row = await env.DB.prepare(
      `SELECT state, d1_database_id FROM pr_environments WHERE id = ?`,
    )
      .bind(prEnvId)
      .first<{ state: string; d1_database_id: string | null }>();
    expect(row?.state).toBe('torn_down');
    // Resources had been created before the failure → teardown had handles to delete.
    expect(row?.d1_database_id).not.toBeNull();
  });
});
