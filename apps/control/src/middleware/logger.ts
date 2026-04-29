import type { MiddlewareHandler } from 'hono';
import { Logger } from '../lib/logger.ts';
import type { ControlAppEnv } from '../app-env.ts';

export const logger = (): MiddlewareHandler<ControlAppEnv> => async (c, next) => {
  const log = new Logger({
    request_id: c.var.requestId,
    env: c.env.RAFT_ENV,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
  });
  c.set('logger', log);
  const started = Date.now();
  await next();
  log.info('request', { status: c.res.status, duration_ms: Date.now() - started });
};
