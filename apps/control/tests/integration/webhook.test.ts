/**
 * Slice B integration test: webhook in → queue consumer → PR env in `ready`
 * (per the Slice B stub provisioning) → audit_log row written.
 *
 * The webhook route hands off to the queue, which the test invokes manually
 * (vitest-pool-workers does not auto-fire queue consumers from `send()`).
 */
import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex } from '../../src/lib/crypto/hmac.ts';
import { handleQueueBatch } from '../../src/queue/consumer.ts';
import type { RaftQueueMessage } from '../../src/env.ts';
import type { PrEnvironment } from '../../src/do/pr-environment.ts';
import type { ProvisionRunner } from '../../src/do/provision-runner.ts';
import { listAuditForTarget } from '../../src/lib/db/auditLog.ts';

const prPayload = {
  action: 'opened',
  number: 7,
  pull_request: {
    number: 7,
    head: { sha: 'sha-head', ref: 'feature/x' },
    base: { sha: 'sha-base', ref: 'main' },
    user: { login: 'alice' },
  },
  repository: { id: 7777, name: 'api', full_name: 'acme/api', default_branch: 'main' },
  installation: { id: 99 },
};

const fakeQueueMessage = (body: RaftQueueMessage): MessageBatch<RaftQueueMessage> => {
  const ack = (): void => undefined;
  const retry = (): void => undefined;
  return {
    queue: 'raft-events',
    messages: [
      {
        id: 'm1',
        timestamp: new Date(),
        body,
        attempts: 1,
        ack,
        retry,
      } as Message<RaftQueueMessage>,
    ],
    ackAll: () => undefined,
    retryAll: () => undefined,
  } as MessageBatch<RaftQueueMessage>;
};

describe('Slice B webhook → queue → DO → audit', () => {
  it('accepts a signed pull_request.opened, processes it, and the PR env reaches ready', async () => {
    const raw = JSON.stringify(prPayload);
    const sig = `sha256=${await hmacSha256Hex(env.GITHUB_WEBHOOK_SECRET, raw)}`;

    const res = await SELF.fetch('https://control.test/webhooks/github', {
      method: 'POST',
      body: raw,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'test-delivery-1',
        'x-hub-signature-256': sig,
      },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: true; data: { accepted: number } };
    expect(body.ok).toBe(true);
    expect(body.data.accepted).toBe(1);

    // The route enqueued; vitest-pool-workers does not auto-fire queue
    // consumers from send(), so we invoke the consumer directly with a
    // batch carrying the same message the route built.
    await handleQueueBatch(
      fakeQueueMessage({
        kind: 'pr.opened',
        deliveryId: 'test-delivery-1',
        payload: {
          installationId: '99',
          repoFullName: 'acme/api',
          githubRepoId: 7777,
          defaultBranch: 'main',
          prNumber: 7,
          headSha: 'sha-head',
          headRef: 'feature/x',
          baseSha: 'sha-base',
          baseBranch: 'main',
          actorLogin: 'alice',
        },
      }),
      env,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExecutionContext stub for test
      {} as any,
    );

    // After dispatch, RepoCoordinator transitions PR env to `provisioning`
    // and starts the ProvisionRunner DO (alarm scheduled, not yet fired).
    const prEnvId = '99:acme/api:7';
    const provisioningRow = await env.DB.prepare(`SELECT state FROM pr_environments WHERE id = ?`)
      .bind(prEnvId)
      .first<{ state: string }>();
    expect(provisioningRow?.state).toBe('provisioning');

    // Drive the alarm chain to completion so the DO ends in a stable state
    // (otherwise vitest-pool-workers' isolated-storage snapshot trips).
    const runner = env.PROVISION_RUNNER.get(
      env.PROVISION_RUNNER.idFromName(prEnvId),
    ) as DurableObjectStub<ProvisionRunner>;
    for (let i = 0; i < 30; i++) {
      await runDurableObjectAlarm(runner);
      const snap = await runInDurableObject(runner, async (r: ProvisionRunner) =>
        r.getStateSnapshot(),
      );
      if (snap?.status === 'succeeded' || snap?.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 20));
    }

    const finalRow = await env.DB.prepare(`SELECT state FROM pr_environments WHERE id = ?`)
      .bind(prEnvId)
      .first<{ state: string }>();
    expect(finalRow?.state).toBe('ready');

    const stub = env.PR_ENV.get(env.PR_ENV.idFromName(prEnvId)) as DurableObjectStub<PrEnvironment>;
    const seen = await runInDurableObject(stub, async (instance: PrEnvironment) => instance.getState());
    expect(seen.state).toBe('ready');

    const audits = await listAuditForTarget(env.DB, 'pr_environment', prEnvId);
    if (!audits.ok) throw audits.error;
    const actions = audits.value.map((a) => a.action);
    expect(actions).toContain('pr_env.received');
    expect(actions).toContain('pr_env.provisioning');
    expect(actions).toContain('pr_env.ready');
    expect(actions).toContain('provision.succeeded');
  });

  it('rejects an unsigned webhook with 401', async () => {
    const res = await SELF.fetch('https://control.test/webhooks/github', {
      method: 'POST',
      body: '{}',
      headers: { 'x-github-event': 'pull_request' },
    });
    expect(res.status).toBe(401);
  });
});
