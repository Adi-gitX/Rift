/**
 * Hex helpers (Workers-compatible — no Node Buffer).
 */
export const bytesToHex = (b: Uint8Array): string => {
  let out = '';
  for (const byte of b) out += byte.toString(16).padStart(2, '0');
  return out;
};

export const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
};
