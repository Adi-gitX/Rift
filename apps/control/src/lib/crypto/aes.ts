/**
 * AES-256-GCM string encryption for secrets at rest in D1 (per-installation
 * Cloudflare API tokens). Key = SHA-256(secret) so any long random Worker
 * secret works as the master key. Ciphertext format: `v1.<iv b64url>.<ct b64url>`.
 *
 * Free-tier substitute for Secrets Store: the master key never leaves the
 * Worker, the DB row alone is useless without it.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64u = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const unb64u = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

const deriveKey = async (secret: string): Promise<CryptoKey> => {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};

export const encryptString = async (secret: string, plaintext: string): Promise<string> => {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `v1.${b64u(iv)}.${b64u(new Uint8Array(ct))}`;
};

export const decryptString = async (secret: string, payload: string): Promise<string> => {
  const [v, ivB, ctB] = payload.split('.');
  if (v !== 'v1' || !ivB || !ctB) throw new Error('aes: unsupported payload');
  const key = await deriveKey(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(ivB) }, key, unb64u(ctB));
  return dec.decode(pt);
};
