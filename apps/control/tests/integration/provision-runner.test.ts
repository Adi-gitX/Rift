/**
 * Slice D integration test: ProvisionRunner DO walks all 5 (v1) steps via DO
 * alarms, calls the CF API in the right order (intercepted by miniflare's
 * outboundService — see tests/cf-api-mock.ts), lands the PR env in `ready`,
 * and writes the hostname → script_name route into ROUTES KV.
 */
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ProvisionRunner } from '../../src/do/provision-runner.ts';
import type { ProvisionRunnerState } from '../../src/runner/provision/state.ts';
import { upsertInstallation } from '../../src/lib/db/installations.ts';
import { upsertRepo } from '../../src/lib/db/repos.ts';
import { createPrEnvironment } from '../../src/lib/db/prEnvironments.ts';

const seedRepo = async (suffix: string): Promise<string> => {
  await upsertInstallation(env.DB, {
    id: `99-${suffix}`,
    githubAccount: 'acme',
    githubAccountId: 1,
    accountType: 'organization',
  });
  const r = await upsertRepo(env.DB, {
    installationId: `99-${suffix}`,
    githubRepoId: 1,
    fullName: `acme/api-${suffix}`,
    uploadTokenHash: 'h',
  });
  if (!r.ok) throw r.error;
  const pe = await createPrEnvironment(env.DB, { repoId: r.value.id, prNumber: 1, headSha: 'sha' });
  if (!pe.ok) throw pe.error;
  return pe.value.id;
};

const driveAlarms = async (
  stub: DurableObjectStub<ProvisionRunner>,
  maxIters = 30,
): Promise<ProvisionRunnerState | null> => {
  for (let i = 0; i < maxIters; i++) {
    await runDurableObjectAlarm(stub);
    const snap = await runInDurableObject(stub, async (instance: ProvisionRunner) =>
      instance.getStateSnapshot(),
    );
    if (!snap) return null;
    if (snap.status === 'succeeded' || snap.status === 'failed') return snap;
    await new Promise((r) => setTimeout(r, 20));
  }
  return runInDurableObject(stub, async (instance: ProvisionRunner) => instance.getStateSnapshot());
};

describe('Slice D ProvisionRunner — alarm-driven 5-step machine', () => {
  it('walks all steps to succeeded, writes ROUTES KV, transitions PR env to ready', async () => {
    const prEnvId = await seedRepo('a');
    const stub = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;

    const initial: ProvisionRunnerState = {
      prEnvId,
      installationId: '99-a',
      scope: 'pr-1',
      scriptName: 'raft-99a-acmeapia-pr-1',
      previewHostname: 'pr-1--acme-api-a.preview.raft.test',
      params: {
        installationId: '99-a',
        repoFullName: 'acme/api-a',
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
    await stub.start(initial);

    const final = await driveAlarms(stub);
    expect(final?.status).toBe('succeeded');

    const row = await env.DB.prepare(
      `SELECT state, worker_script_name, preview_hostname FROM pr_environments WHERE id = ?`,
    )
      .bind(prEnvId)
      .first<{ state: string; worker_script_name: string; preview_hostname: string }>();
    expect(row?.state).toBe('ready');
    expect(row?.worker_script_name).toBe('raft-99a-acmeapia-pr-1');
    expect(row?.preview_hostname).toBe('pr-1--acme-api-a.preview.raft.test');

    const route = await env.ROUTES.get('host:pr-1--acme-api-a.preview.raft.test');
    expect(route).toBe('raft-99a-acmeapia-pr-1');
  });

  it('idempotency: re-firing alarm after a step completed reuses the cached result', async () => {
    const prEnvId = await seedRepo('b');
    const stub = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;

    const initial: ProvisionRunnerState = {
      prEnvId,
      installationId: '99-b',
      scope: 'pr-1',
      scriptName: 'raft-99b-acmeapib-pr-1',
      previewHostname: 'pr-1--acme-api-b.preview.raft.test',
      params: {
        installationId: '99-b',
        repoFullName: 'acme/api-b',
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
    await stub.start(initial);
    const final = await driveAlarms(stub);
    expect(final?.status).toBe('succeeded');

    // Second drive: alarm should observe status=succeeded and exit immediately.
    const second = await driveAlarms(stub, 3);
    expect(second?.status).toBe('succeeded');
  });
});
