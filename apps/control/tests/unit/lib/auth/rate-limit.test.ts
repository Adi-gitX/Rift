import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { checkRateLimit } from '../../../../src/lib/auth/rate-limit.ts';

describe('checkRateLimit', () => {
  it('allows up to limit then denies', async () => {
    let allowed = 0;
    for (let i = 0; i < 7; i++) {
      const v = await checkRateLimit(env.CACHE, 'rl-test-1', 5, 60);
      if (v.allowed) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it('different keys have independent counters', async () => {
    const a = await checkRateLimit(env.CACHE, 'rl-test-A', 1, 60);
    const b = await checkRateLimit(env.CACHE, 'rl-test-B', 1, 60);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    const a2 = await checkRateLimit(env.CACHE, 'rl-test-A', 1, 60);
    expect(a2.allowed).toBe(false);
  });
});
