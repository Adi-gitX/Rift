/**
 * Timing-safe HMAC-SHA256 verifier built on Web Crypto.
 * `crypto.subtle.verify` is timing-safe by spec — no manual constant-time
 * compare needed.
 */
import { hexToBytes } from './hex.ts';

const enc = new TextEncoder();

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

export const hmacSha256Hex = async (secret: string, payload: string): Promise<string> => {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  let out = '';
  const view = new Uint8Array(sig);
  for (const byte of view) out += byte.toString(16).padStart(2, '0');
  return out;
};

/**
 * Verifies a GitHub-style `X-Hub-Signature-256: sha256=<hex>` header.
 * Returns false on any malformed input — never throws.
 */
export const verifyGithubSignature = async (
  secret: string,
  signatureHeader: string | null,
  payload: string,
): Promise<boolean> => {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const hex = signatureHeader.slice('sha256='.length);
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return false;
  let key: CryptoKey;
  try {
    key = await importKey(secret);
  } catch {
    return false;
  }
  return crypto.subtle.verify('HMAC', key, hexToBytes(hex), enc.encode(payload));
};
