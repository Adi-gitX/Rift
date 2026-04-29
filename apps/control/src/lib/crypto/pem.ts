/**
 * PEM helpers — strip headers, decode base64, return raw key bytes.
 * Workers-safe (uses atob, no Node Buffer).
 */
const stripPem = (pem: string): string =>
  pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');

export const pemToBytes = (pem: string): Uint8Array => {
  const b64 = stripPem(pem);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
