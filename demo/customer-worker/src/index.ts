/**
 * Demo customer Worker — a tiny Hono app exercising every binding type
 * Raft isolates per PR: D1, KV, Queue, and a Durable Object.
 *
 * The Raft bundle rewriter swaps these binding IDs for per-PR ones at
 * provision time, and emits a wrapper for the ROOM DO class so every
 * `idFromName` is silently scoped to this PR.
 */
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';

interface DemoEnv {
  readonly DB: D1Database;
  readonly KV: KVNamespace;
  readonly JOBS: Queue<unknown>;
  readonly ROOM: DurableObjectNamespace<ChatRoom>;
  // Injected by Raft's bundle rewriter:
  readonly RAFT_PR_SCOPE: string;
  readonly RAFT_INTERNAL_DISPATCH_SECRET: string;
}

const app = new Hono<{ Bindings: DemoEnv }>();

app.get('/', (c) =>
  c.json({
    app: 'demo-customer',
    pr_scope: c.env.RAFT_PR_SCOPE ?? 'unknown',
    note: 'every binding here is per-PR in a Raft preview',
  }),
);

app.get('/visit', async (c) => {
  const count = parseInt((await c.env.KV.get('visits')) ?? '0', 10) + 1;
  await c.env.KV.put('visits', String(count));
  return c.json({ visits: count, scope: c.env.RAFT_PR_SCOPE });
});

app.get('/room/:name', async (c) => {
  const id = c.env.ROOM.idFromName(c.req.param('name'));
  const stub = c.env.ROOM.get(id);
  return stub.fetch(c.req.raw);
});

export class ChatRoom extends DurableObject<DemoEnv> {
  override async fetch(req: Request): Promise<Response> {
    const visits = ((await this.ctx.storage.get<number>('hits')) ?? 0) + 1;
    await this.ctx.storage.put('hits', visits);
    const url = new URL(req.url);
    return Response.json({
      room: url.pathname,
      hits: visits,
      pr_scope: this.env.RAFT_PR_SCOPE,
    });
  }
}

const handler: ExportedHandler<DemoEnv> = {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
