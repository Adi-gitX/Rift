/**
 * POST /webhooks/github — HMAC-verify, parse, enqueue.
 * Goal: <200ms response time. Provisioning happens off the queue.
 */
import { Hono } from 'hono';
import { apiOk } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';
import { consumeWebhook } from '../lib/github/webhooks.ts';
import { translate } from '../lib/github/translate.ts';

export const githubRoutes = new Hono<ControlAppEnv>();

githubRoutes.post('/webhooks/github', async (c) => {
  const log = c.var.logger;
  const raw = await c.req.text();
  const outcome = await consumeWebhook(c.env.GITHUB_WEBHOOK_SECRET, raw, c.req.raw.headers);
  if (!outcome.ok) {
    log.warn('webhook_rejected', { status: outcome.status, reason: outcome.reason });
    return c.body(null, outcome.status);
  }
  log.info('webhook_accepted', { event: outcome.eventName, delivery: outcome.deliveryId });
  if (outcome.parsed.kind === 'ignored') {
    log.info('webhook_ignored', { reason: outcome.parsed.reason });
    return c.body(null, 204);
  }
  const messages = translate(outcome.parsed, outcome.deliveryId);
  await Promise.all(messages.map((m) => c.env.EVENTS.send(m)));
  return c.json(apiOk({ accepted: messages.length, delivery: outcome.deliveryId }, c.var.requestId), 202);
});
