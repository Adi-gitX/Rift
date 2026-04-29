import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, verifyGithubSignature } from '../../../../src/lib/crypto/hmac.ts';

const SECRET = 'test-secret';
const PAYLOAD = '{"hello":"world"}';

describe('verifyGithubSignature', () => {
  it('accepts a valid signature header', async () => {
    const hex = await hmacSha256Hex(SECRET, PAYLOAD);
    expect(await verifyGithubSignature(SECRET, `sha256=${hex}`, PAYLOAD)).toBe(true);
  });

  it('rejects a tampered payload', async () => {
    const hex = await hmacSha256Hex(SECRET, PAYLOAD);
    expect(await verifyGithubSignature(SECRET, `sha256=${hex}`, `${PAYLOAD} `)).toBe(false);
  });

  it('rejects wrong secret', async () => {
    const hex = await hmacSha256Hex('other-secret', PAYLOAD);
    expect(await verifyGithubSignature(SECRET, `sha256=${hex}`, PAYLOAD)).toBe(false);
  });

  it('rejects missing/malformed headers', async () => {
    expect(await verifyGithubSignature(SECRET, null, PAYLOAD)).toBe(false);
    expect(await verifyGithubSignature(SECRET, '', PAYLOAD)).toBe(false);
    expect(await verifyGithubSignature(SECRET, 'sha256=zz', PAYLOAD)).toBe(false);
    expect(await verifyGithubSignature(SECRET, 'sha1=abcdef', PAYLOAD)).toBe(false);
  });
});
