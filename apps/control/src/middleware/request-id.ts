import type { MiddlewareHandler } from 'hono';
import type { ControlAppEnv } from '../app-env.ts';

export const requestId = (): MiddlewareHandler<ControlAppEnv> => async (c, next) => {
  const inbound =
    c.req.header('x-request-id') ?? c.req.header('cf-ray') ?? crypto.randomUUID();
  c.set('requestId', inbound);
  c.header('x-request-id', inbound);
  await next();
};
