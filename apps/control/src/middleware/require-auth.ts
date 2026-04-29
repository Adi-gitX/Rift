import type { MiddlewareHandler } from 'hono';
import { apiErr } from '@raft/shared-types';
import { type SessionPayload, verifySession } from '../lib/auth/cookies.ts';
import type { ControlAppEnv } from '../app-env.ts';

declare module 'hono' {
  interface ContextVariableMap {
    session?: SessionPayload;
  }
}

const SESSION_COOKIE_RE = /(?:^|;\s*)raft_session=([^;]+)/;

export const requireAuth = (): MiddlewareHandler<ControlAppEnv> => async (c, next) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const match = SESSION_COOKIE_RE.exec(cookieHeader);
  if (!match) {
    return c.json(apiErr('E_AUTH', 'no session cookie', c.var.requestId), 401);
  }
  const session = await verifySession(match[1] ?? '', c.env.SESSION_SIGNING_KEY);
  if (!session) {
    return c.json(apiErr('E_AUTH', 'invalid session', c.var.requestId), 401);
  }
  c.set('session', session);
  await next();
  return undefined;
};
