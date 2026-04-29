import { describe, expect, it } from 'vitest';
import {
  hashUploadToken,
  isUploadTokenShape,
  mintUploadToken,
  verifyUploadToken,
} from '../../../../src/lib/auth/upload-token.ts';

describe('upload tokens (PRD A6)', () => {
  it('mints a raft_ut_-prefixed base64url token', () => {
    const t = mintUploadToken();
    expect(t.startsWith('raft_ut_')).toBe(true);
    expect(isUploadTokenShape(t)).toBe(true);
  });

  it('round-trips: mint → hash → verify', async () => {
    const t = mintUploadToken();
    const h = await hashUploadToken(t);
    expect(await verifyUploadToken(t, h)).toBe(true);
  });

  it('rejects bad shape, even if hash matches', async () => {
    const wrongShape = 'wrong_prefix_token';
    const h = await hashUploadToken(wrongShape);
    expect(await verifyUploadToken(wrongShape, h)).toBe(false);
  });

  it('rejects mismatched hash', async () => {
    const t1 = mintUploadToken();
    const t2 = mintUploadToken();
    const h1 = await hashUploadToken(t1);
    expect(await verifyUploadToken(t2, h1)).toBe(false);
  });
});
