/**
 * Legacy server-rendered dashboard routes have been retired. The React SPA
 * at apps/dashboard/dist now owns / and /dashboard/* via the ASSETS binding
 * (see `not_found_handling: single-page-application` in wrangler.jsonc and
 * the SPA fallback in middleware/error.ts).
 *
 * What survives here is the WebSocket log stream — proxies the upgrade to
 * the per-PR LogTail DO so the dashboard can subscribe to live trace events.
 */
import { Hono } from 'hono';
import type { ControlAppEnv } from '../app-env.ts';

export const dashboardRoutes = new Hono<ControlAppEnv>();

dashboardRoutes.get('/api/v1/prs/:prEnvId/logs/stream', async (c) => {
  const upgrade = c.req.header('upgrade');
  if (upgrade !== 'websocket') return c.text('expected websocket upgrade', 400);
  const id = decodeURIComponent(c.req.param('prEnvId'));
  const stub = c.env.LOGTAIL.get(c.env.LOGTAIL.idFromName(id));
  return stub.fetch(new Request('https://internal/ws', { headers: { upgrade: 'websocket' } }));
});
