/**
 * Webhook entrypoint helpers: HMAC verify + parse + classify.
 * Returns a discriminated union the route handler can switch on.
 */
import { verifyGithubSignature } from '../crypto/hmac.ts';
import { type ParsedEvent, parseEvent } from './schemas.ts';

export type WebhookOutcome =
  | { ok: true; eventName: string; deliveryId: string; parsed: ParsedEvent }
  | { ok: false; status: 401 | 400; reason: string };

export const consumeWebhook = async (
  secret: string,
  rawBody: string,
  headers: Headers,
): Promise<WebhookOutcome> => {
  const sig = headers.get('x-hub-signature-256');
  const eventName = headers.get('x-github-event');
  const deliveryId = headers.get('x-github-delivery') ?? '';
  if (!eventName) return { ok: false, status: 400, reason: 'missing X-GitHub-Event' };
  const valid = await verifyGithubSignature(secret, sig, rawBody);
  if (!valid) return { ok: false, status: 401, reason: 'invalid signature' };
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: 'invalid JSON body' };
  }
  return { ok: true, eventName, deliveryId, parsed: parseEvent(eventName, body) };
};
