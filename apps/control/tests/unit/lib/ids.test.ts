import { describe, expect, it } from 'vitest';
import { ulid } from '../../../src/lib/ids.ts';

describe('ulid', () => {
  it('produces 26-char Crockford-base32 strings', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/);
  });

  it('orders lexicographically by time', () => {
    const a = ulid(1_000_000);
    const b = ulid(2_000_000);
    expect(a < b).toBe(true);
  });

  it('is unique across many invocations', () => {
    const set = new Set(Array.from({ length: 500 }, () => ulid()));
    expect(set.size).toBe(500);
  });
});
