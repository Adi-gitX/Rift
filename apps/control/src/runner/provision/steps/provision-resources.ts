/**
 * Step 3 — provision-resources: create the per-PR D1 + KV + Queue.
 *
 * Idempotent list-then-create. CF returns different "already exists"
 * shapes per resource type (D1: 400+7502, KV: 400+10014, Queue: 409+11009),
 * so we LIST first and only create if not present. Names are deterministic
 * per PR, so replays and redeploys reuse the same resources.
 */
import type { CFClient } from '../../../lib/cloudflare/client.ts';
import * as cfD1 from '../../../lib/cloudflare/d1.ts';
import * as cfKv from '../../../lib/cloudflare/kv.ts';
import * as cfQueues from '../../../lib/cloudflare/queues.ts';
import { readListBody } from '../../../lib/cloudflare/list.ts';
import { setResourceHandles } from '../../../lib/db/prEnvironments.ts';
import { cfClientFromCtx, type StepContext } from './context.ts';
import type { ProvisionResourcesResult } from './types.ts';

interface Names {
  d1Name: string;
  kvTitle: string;
  queueName: string;
}

const namesFor = (scriptName: string): Names => ({
  d1Name: `${scriptName}-db`,
  kvTitle: `${scriptName}-kv`,
  queueName: `${scriptName}-q`,
});

interface Existing {
  d1?: { uuid: string; name: string };
  kv?: { id: string; title: string };
  queue?: { queue_id: string; queue_name: string };
}

const findExisting = async (client: CFClient, ctx: StepContext, n: Names): Promise<Existing> => {
  const [d1List, kvList, queueList] = await Promise.all([
    readListBody(
      client,
      ctx.log,
      `/d1/database?name=${encodeURIComponent(n.d1Name)}&per_page=100`,
      'd1',
    ),
    readListBody(client, ctx.log, '/storage/kv/namespaces?per_page=100', 'kv'),
    readListBody(client, ctx.log, '/queues?per_page=100', 'queues'),
  ]);
  const out: Existing = {};
  const d1 = (d1List as { uuid?: string; name?: string }[] | null)?.find(
    (d) => d.name === n.d1Name,
  );
  const kv = (kvList as { id?: string; title?: string }[] | null)?.find(
    (k) => k.title === n.kvTitle,
  );
  const q = (queueList as { queue_id?: string; queue_name?: string }[] | null)?.find(
    (x) => x.queue_name === n.queueName,
  );
  if (d1?.uuid && d1.name) out.d1 = { uuid: d1.uuid, name: d1.name };
  if (kv?.id && kv.title) out.kv = { id: kv.id, title: kv.title };
  if (q?.queue_id && q.queue_name) out.queue = { queue_id: q.queue_id, queue_name: q.queue_name };
  return out;
};

/** Create whatever `findExisting` did not find. Throws (retryable) on any CF failure. */
const createMissing = async (
  client: CFClient,
  ctx: StepContext,
  n: Names,
  existing: Existing,
): Promise<Required<Existing>> => {
  const d1 = existing.d1
    ? { ok: true as const, value: existing.d1 }
    : await cfD1.createDatabase(client, n.d1Name);
  const kv = existing.kv
    ? { ok: true as const, value: existing.kv }
    : await cfKv.createNamespace(client, n.kvTitle);
  const queue = existing.queue
    ? { ok: true as const, value: existing.queue }
    : await cfQueues.createQueue(client, n.queueName);
  for (const [label, r] of [
    ['d1', d1],
    ['kv', kv],
    ['queue', queue],
  ] as const) {
    if (!r.ok) {
      ctx.log.error(`provision_${label}_failed`, { msg: r.error.message });
      throw r.error;
    }
  }
  if (!d1.ok || !kv.ok || !queue.ok) throw new Error('unreachable');
  return { d1: d1.value, kv: kv.value, queue: queue.value };
};

export const provisionResources = async (ctx: StepContext): Promise<ProvisionResourcesResult> => {
  const client = cfClientFromCtx(ctx);
  ctx.log.info('provision_resources', { script: ctx.scriptName });
  const names = namesFor(ctx.scriptName);
  const existing = await findExisting(client, ctx, names);
  const { d1, kv, queue } = await createMissing(client, ctx, names, existing);

  const result: ProvisionResourcesResult = {
    d1: { binding: 'DB', database_id: d1.uuid, database_name: d1.name },
    kv: { binding: 'KV', id: kv.id, title: kv.title },
    queue: { binding: 'QUEUE', queue_name: queue.queue_name, queue_id: queue.queue_id },
    r2Prefix: `tenants/${ctx.params.installationId}/${ctx.scope}/`,
  };
  await setResourceHandles(ctx.env.DB, ctx.prEnvId, {
    d1DatabaseId: result.d1.database_id,
    kvNamespaceId: result.kv.id,
    // Store the UUID (required by `DELETE /queues/{id}` at teardown), NOT
    // the human-readable queue_name. The user-Worker binding still uses
    // queue_name via the bundle rewriter.
    queueId: result.queue.queue_id,
    r2Prefix: result.r2Prefix,
    doNamespaceSeed: ctx.scope,
  });
  return result;
};
