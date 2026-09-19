/**
 * MD5 (RFC 1321). Web Crypto has no MD5, but the D1 import API requires the
 * upload `etag` to be the MD5 of the SQL file — ingest rejects any other
 * digest with "Input file … missing or invalid". Only used for that etag.
 */
const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
);

const rotl = (x: number, c: number): number => (x << c) | (x >>> (32 - c));

const toBlocks = (input: Uint8Array): Uint32Array => {
  const bitLen = input.length * 8;
  const padded = new Uint8Array((((input.length + 8) >> 6) + 1) << 6);
  padded.set(input);
  padded[input.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLen >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true);
  const words = new Uint32Array(padded.length / 4);
  for (let i = 0; i < words.length; i++) words[i] = view.getUint32(i * 4, true);
  return words;
};

const round = (i: number, b: number, c: number, d: number): [number, number] => {
  if (i < 16) return [(b & c) | (~b & d), i];
  if (i < 32) return [(d & b) | (~d & c), (5 * i + 1) % 16];
  if (i < 48) return [b ^ c ^ d, (3 * i + 5) % 16];
  return [c ^ (b | ~d), (7 * i) % 16];
};

export const md5Hex = (input: Uint8Array | string): string => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const words = toBlocks(bytes);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < words.length; off += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      const [f, g] = round(i, b, c, d);
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + (K[i] ?? 0) + (words[off + g] ?? 0)) >>> 0, S[i] ?? 0)) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return Array.from(new Uint8Array(out.buffer))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
};
