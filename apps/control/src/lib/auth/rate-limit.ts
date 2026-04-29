/**
 * Per-key sliding-window rate limit backed by KV.
 *
 * Bucketed: each (key, bucket=floor(now/window)) gets its own KV row with
 * an integer counter. KV puts have an expirationTtl of 2*window so old
 * buckets are automatically reaped. Not strictly sliding (it's a fixed
 * window), but fine for the order-of-magnitude limits we care about
 * (30 webhooks/min, 100 API calls/min — PRD §12.2.5).
 *
 * Note on KV consistency: KV puts can lag up to ~60s between regions,
 * so this is a best-effort limit. For the demo it's enough; production
 * would back the counters with a DO if hard limits matter.
 */
export interface RateLimitVerdict {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export const checkRateLimit = async (
  cache: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitVerdict> => {
  const now = Math.floor(Date.now() / 1000);
  const bucket = Math.floor(now / windowSeconds);
  const fullKey = `rl:${key}:${bucket}`;
  const current = parseInt((await cache.get(fullKey)) ?? '0', 10);
  const resetAt = (bucket + 1) * windowSeconds;
  if (current >= limit) return { allowed: false, remaining: 0, resetAt };
  await cache.put(fullKey, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return { allowed: true, remaining: limit - current - 1, resetAt };
};
