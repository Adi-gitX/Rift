/**
 * raft-control Worker entry.
 *
 * Hono router + middleware chain serves /healthz, /version, and the
 * GitHub webhook ingress (Slice B). Off-the-queue work is dispatched to
 * RepoCoordinator / PrEnvironment DOs. ProvisionRunner / TeardownRunner
 * (Slices D + E) are alarm-driven DOs that replace Cloudflare Workflows
 * under the free-tier substitution.
 */
import { Hono } from 'hono';
import { apiOk } from '@raft/shared-types';
import type { Env, RaftQueueMessage } from './env.ts';
import type { ControlAppEnv } from './app-env.ts';
import { requestId } from './middleware/request-id.ts';
import { logger as loggerMiddleware } from './middleware/logger.ts';
import { onError, onNotFound } from './middleware/error.ts';
import { githubRoutes } from './routes/github.ts';
import { handleQueueBatch } from './queue/consumer.ts';
import { sweepStaleEnvironments } from './scheduled/sweep.ts';

const VERSION = '0.1.0';

const app = new Hono<ControlAppEnv>();

app.use('*', requestId());
app.use('*', loggerMiddleware());
app.onError(onError());
app.notFound(onNotFound());

app.get('/healthz', (c) => c.json(apiOk({ ok: true }, c.var.requestId)));

app.get('/version', (c) =>
  c.json(
    apiOk(
      {
        name: 'raft-control',
        version: VERSION,
        env: c.env.RAFT_ENV,
        compat_date: '2026-04-29',
      },
      c.var.requestId,
    ),
  ),
);

app.route('/', githubRoutes);

export { RepoCoordinator } from './do/repo-coordinator.ts';
export { PrEnvironment } from './do/pr-environment.ts';
export { LogTail } from './do/log-tail.ts';
export { ProvisionRunner } from './do/provision-runner.ts';
export { TeardownRunner } from './do/teardown-runner.ts';

const handler: ExportedHandler<Env, RaftQueueMessage> = {
  fetch(req, env, ctx) {
    return app.fetch(req, env, ctx);
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sweepStaleEnvironments(env));
  },
  async queue(batch, env, ctx) {
    await handleQueueBatch(batch, env, ctx);
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers runtime requires a default export entry; documented exception per PRD §20.
export default handler;
