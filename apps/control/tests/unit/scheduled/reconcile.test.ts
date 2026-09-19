import { describe, expect, it, vi } from 'vitest';
import { CFClient } from '../../../src/lib/cloudflare/client.ts';
import { Logger } from '../../../src/lib/logger.ts';
import {
  derivePrScriptName,
  findOrphans,
  listAccountResources,
  type AccountResources,
} from '../../../src/scheduled/reconcile.ts';

describe('derivePrScriptName', () => {
  it('maps per-PR resource names to their script and ignores control-plane names', () => {
    expect(derivePrScriptName('raft-128067035-adigitxraftdemot-pr-8')).toBe(
      'raft-128067035-adigitxraftdemot-pr-8',
    );
    expect(derivePrScriptName('raft-128067035-adigitxraftdemot-pr-8-db')).toBe(
      'raft-128067035-adigitxraftdemot-pr-8',
    );
    expect(derivePrScriptName('raft-128067035-adigitxraftdemot-pr-8-kv')).toBe(
      'raft-128067035-adigitxraftdemot-pr-8',
    );
    expect(derivePrScriptName('raft-128067035-adigitxraftdemot-pr-8-q')).toBe(
      'raft-128067035-adigitxraftdemot-pr-8',
    );
    for (const safe of [
      'raft-control',
      'raft-dispatcher',
      'raft-tail',
      'raft-meta',
      'raft-demo-source',
      'raft-routes',
      'raft-cache',
      'raft-events',
      'raft-events-dlq',
      'raft-tail-events',
      'my-app',
    ]) {
      expect(derivePrScriptName(safe)).toBeNull();
    }
  });
});

const resources: AccountResources = {
  scripts: [
    { id: 'raft-control' },
    { id: 'raft-1-repo-pr-8' },
    { id: 'raft-1-repo-pr-9' },
    { id: 'raft-1-repo-pr-10' },
  ],
  d1: [
    { uuid: 'meta', name: 'raft-meta' },
    { uuid: 'db8', name: 'raft-1-repo-pr-8-db' },
    { uuid: 'db9', name: 'raft-1-repo-pr-9-db' },
  ],
  kv: [
    { id: 'kv8', title: 'raft-1-repo-pr-8-kv' },
    { id: 'routes', title: 'raft-routes' },
  ],
  queues: [
    { queue_id: 'q8', queue_name: 'raft-1-repo-pr-8-q' },
    { queue_id: 'qe', queue_name: 'raft-events' },
  ],
};

const rows = new Map([
  [
    'raft-1-repo-pr-8',
    {
      id: 'i:r:8',
      state: 'torn_down',
      worker_script_name: 'raft-1-repo-pr-8',
      installation_id: 'i',
    },
  ],
  [
    'raft-1-repo-pr-9',
    { id: 'i:r:9', state: 'ready', worker_script_name: 'raft-1-repo-pr-9', installation_id: 'i' },
  ],
]);

describe('findOrphans', () => {
  it('flags resources of torn_down envs, keeps live envs, ignores rowless unless forced', () => {
    const orphans = findOrphans(resources, rows, { force: false });
    expect(orphans.map((o) => `${o.kind}:${o.id}`).sort()).toEqual([
      'd1:db8',
      'kv:kv8',
      'queue:q8',
      'worker:raft-1-repo-pr-8',
    ]);
    expect(orphans[0]).toMatchObject({
      prEnvId: 'i:r:8',
      prEnvState: 'torn_down',
      installationId: 'i',
    });
    // pr-9 is ready → never touched; pr-10 has no row → only with force.
    expect(orphans.some((o) => o.scriptName === 'raft-1-repo-pr-9')).toBe(false);
    expect(orphans.some((o) => o.scriptName === 'raft-1-repo-pr-10')).toBe(false);
    const forced = findOrphans(resources, rows, { force: true });
    expect(
      forced.some((o) => o.scriptName === 'raft-1-repo-pr-10' && o.prEnvId === undefined),
    ).toBe(true);
    // Control-plane resources are never candidates, even when forced.
    expect(
      forced.some((o) =>
        ['raft-control', 'raft-meta', 'raft-routes', 'raft-events'].includes(o.name),
      ),
    ).toBe(false);
  });
});

describe('listAccountResources', () => {
  it('reads the four list endpoints and tolerates a failing one', async () => {
    const cfOk = (result: unknown): Response =>
      new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
        status: 200,
      });
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/workers/scripts')) return cfOk([{ id: 'raft-1-repo-pr-8' }]);
      if (url.includes('/d1/database')) return cfOk([{ uuid: 'db8', name: 'raft-1-repo-pr-8-db' }]);
      if (url.includes('/storage/kv')) return new Response('nope', { status: 403 });
      return cfOk([{ queue_id: 'q8', queue_name: 'raft-1-repo-pr-8-q' }]);
    }) as unknown as typeof fetch;
    const client = new CFClient({
      accountId: 'a',
      token: 't',
      fetcher,
      baseDelayMs: 0,
      maxRetries: 0,
    });
    const res = await listAccountResources(client, new Logger({}));
    expect(res.scripts).toHaveLength(1);
    expect(res.d1).toHaveLength(1);
    expect(res.kv).toEqual([]);
    expect(res.queues).toHaveLength(1);
  });
});
