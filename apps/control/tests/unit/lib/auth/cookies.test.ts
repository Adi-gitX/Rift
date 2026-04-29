import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../../../../src/lib/auth/cookies.ts';

const KEY = 'test-key-32-bytes-long-enough!!!';

describe('signSession + verifySession', () => {
  it('round-trips a valid session', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const cookie = await signSession({ sub: 'a@b.com', exp }, KEY);
    const round = await verifySession(cookie, KEY);
    expect(round?.sub).toBe('a@b.com');
    expect(round?.exp).toBe(exp);
  });

  it('rejects expired sessions', async () => {
    const cookie = await signSession({ sub: 'a@b.com', exp: 1 }, KEY);
    expect(await verifySession(cookie, KEY)).toBeNull();
  });

  it('rejects tampered payload', async () => {
    const cookie = await signSession({ sub: 'a@b.com', exp: 9999999999 }, KEY);
    const dotAt = cookie.indexOf('.');
    const tampered = cookie.slice(0, dotAt - 1) + 'X' + cookie.slice(dotAt);
    expect(await verifySession(tampered, KEY)).toBeNull();
  });

  it('rejects wrong key', async () => {
    const cookie = await signSession({ sub: 'a@b.com', exp: 9999999999 }, KEY);
    expect(await verifySession(cookie, 'other-key')).toBeNull();
  });

  it('rejects garbage', async () => {
    expect(await verifySession('not-a-cookie', KEY)).toBeNull();
    expect(await verifySession('', KEY)).toBeNull();
    expect(await verifySession('a.b', KEY)).toBeNull();
  });
});
