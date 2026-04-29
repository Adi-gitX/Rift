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

// API paths return JSON 404. Everything else delegates to the ASSETS binding,
// which serves the dashboard SPA (index.html fallback for client-side routes
// is configured via wrangler.jsonc `not_found_handling: single-page-application`).
export const onNotFound = (): NotFoundHandler<ControlAppEnv> => async (c) => {
  const path = c.req.path;
  const isApiPath = path.startsWith('/api/') || path.startsWith('/healthz') || path.startsWith('/version') || path.startsWith('/webhooks/');
  if (isApiPath) {
    return c.json(apiErr('E_NOT_FOUND', `Route ${c.req.method} ${path} not found`, c.var.requestId), 404);
  }
  // Delegate to the dashboard SPA via static assets.
  return c.env.ASSETS.fetch(c.req.raw);
};
