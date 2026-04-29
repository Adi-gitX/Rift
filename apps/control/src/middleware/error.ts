import type { ErrorHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { CodedError, apiErr } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';

export const onError = (): ErrorHandler<ControlAppEnv> => (e, c) => {
  const requestId = c.var.requestId;
  const log = c.var.logger;

  if (e instanceof CodedError) {
    log.warn('request_failed', { code: e.code, status: e.status, message: e.message });
    return c.json(
      apiErr(e.code, e.message, requestId, e.details),
      e.status as ContentfulStatusCode,
    );
  }

  log.error('request_unhandled', {
    err: String(e),
    stack: e instanceof Error ? e.stack : undefined,
  });
  return c.json(apiErr('E_INTERNAL', 'Internal server error', requestId), 500);
};

export const onNotFound = (): NotFoundHandler<ControlAppEnv> => (c) =>
  c.json(apiErr('E_NOT_FOUND', `Route ${c.req.method} ${c.req.path} not found`, c.var.requestId), 404);
