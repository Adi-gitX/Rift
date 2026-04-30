/**
 * POST /webhooks/github — HMAC-verify, dedup, parse, enqueue.
 * Goal: <200ms response time. Provisioning happens off the queue.
 *
 * Deduplication: GitHub retries deliveries on timeout (the famous "every
 * webhook, twice" problem). We stash each delivery_id in CACHE for 24h.
 * A re-arriving id returns 200 with `accepted: 0, dedup: true` — fast,
 * idempotent, no double-provision.
 */
import { Hono } from 'hono';
import { apiOk } from '@raft/shared-types';
import type { ControlAppEnv } from '../app-env.ts';
import { consumeWebhook } from '../lib/github/webhooks.ts';
import { translate } from '../lib/github/translate.ts';

export const githubRoutes = new Hono<ControlAppEnv>();

const DEDUP_TTL_SECONDS = 24 * 60 * 60;
const dedupKey = (deliveryId: string): string => `webhook-dedup:${deliveryId}`;

githubRoutes.post('/webhooks/github', async (c) => {
  const log = c.var.logger;
  const raw = await c.req.text();
  const outcome = await consumeWebhook(c.env.GITHUB_WEBHOOK_SECRET, raw, c.req.raw.headers);
  if (!outcome.ok) {
    log.warn('webhook_rejected', { status: outcome.status, reason: outcome.reason });
    return c.body(null, outcome.status);
  }
  log.info('webhook_accepted', { event: outcome.eventName, delivery: outcome.deliveryId });

  const seen = await c.env.CACHE.get(dedupKey(outcome.deliveryId));
  if (seen) {
    log.info('webhook_deduped', { delivery: outcome.deliveryId });
    return c.json(apiOk({ accepted: 0, delivery: outcome.deliveryId, dedup: true }, c.var.requestId), 200);
  }
  // Stash *before* enqueue so a flapping retry never sees a window where
  // the message has been queued but the dedup key isn't set yet.
  await c.env.CACHE.put(dedupKey(outcome.deliveryId), '1', { expirationTtl: DEDUP_TTL_SECONDS });

  if (outcome.parsed.kind === 'ignored') {
    log.info('webhook_ignored', { reason: outcome.parsed.reason });
    return c.body(null, 204);
  }
  const messages = translate(outcome.parsed, outcome.deliveryId);
  await Promise.all(messages.map((m) => c.env.EVENTS.send(m)));
  return c.json(apiOk({ accepted: messages.length, delivery: outcome.deliveryId }, c.var.requestId), 202);
});
