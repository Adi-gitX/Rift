/**
 * Time-sortable IDs.
 *
 * We use a Crockford-base32 ULID (26 chars: 10 chars time + 16 chars random)
 * for deployments, audit_log, and usage_records — anywhere we want
 * lexicographic order to match insertion order without an extra index.
 *
 * No npm dependency: ~25 lines, Workers-compatible (Web Crypto only).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encodeBase32 = (bytes: Uint8Array, length: number): string => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      const idx = (value >>> bits) & 31;
      out += ALPHABET[idx];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.slice(0, length);
};

const encodeTime = (ms: number): string => {
  const bytes = new Uint8Array(6);
  let n = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = n & 0xff;
    n = Math.floor(n / 256);
  }
  return encodeBase32(bytes, 10);
};

export const ulid = (now: number = Date.now()): string => {
  const random = new Uint8Array(10);
  crypto.getRandomValues(random);
  return encodeTime(now) + encodeBase32(random, 16);
};
