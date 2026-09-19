import { describe, expect, it } from 'vitest';
import { md5Hex } from '../../../../src/lib/crypto/md5.ts';

describe('md5Hex', () => {
  it('matches RFC 1321 test vectors', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe(
      '9e107d9d372bb6826bd81d3542a419d6',
    );
  });
  it('handles inputs crossing the 55/56/64-byte padding boundaries', () => {
    expect(md5Hex('a'.repeat(55))).toBe('ef1772b6dff9a122358552954ad0df65');
    expect(md5Hex('a'.repeat(56))).toBe('3b0c8ac703f828b04c6c197006d17218');
    expect(md5Hex('a'.repeat(64))).toBe('014842d480b571495a4a0363793f7367');
    expect(md5Hex('1234567890'.repeat(8))).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });
});
