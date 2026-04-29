/**
 * Signed-cookie session auth (free-tier substitution for Cloudflare Access).
 *
 * Cookie format: `<base64url(payload)>.<base64url(hmacSha256(payload))>`
 * Payload: `{ sub: string; exp: number }` — `sub` is the operator email
 * supplied at /login, `exp` is unix-seconds expiry (default 7 days).
 *
 * Verification uses crypto.subtle.verify (timing-safe by spec).
 */
import { hexToBytes } from '../crypto/hex.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface SessionPayload {
  sub: string;
  exp: number;
}

const b64UrlBytes = (bytes: Uint8Array): string => {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64UrlDecode = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
};

const importKey = (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

const hmacHex = async (key: CryptoKey, data: string): Promise<string> => {
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  let out = '';
  for (const byte of new Uint8Array(sig)) out += byte.toString(16).padStart(2, '0');
  return out;
};

export const signSession = async (
  payload: SessionPayload,
  secret: string,
): Promise<string> => {
  const data = b64UrlBytes(enc.encode(JSON.stringify(payload)));
  const key = await importKey(secret);
  return `${data}.${await hmacHex(key, data)}`;
};

export const verifySession = async (
  cookie: string,
  secret: string,
): Promise<SessionPayload | null> => {
  const dotAt = cookie.indexOf('.');
  if (dotAt <= 0) return null;
  const data = cookie.slice(0, dotAt);
  const sig = cookie.slice(dotAt + 1);
  if (sig.length !== 64 || !/^[0-9a-f]+$/i.test(sig)) return null;
  let key: CryptoKey;
  try {
    key = await importKey(secret);
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', key, hexToBytes(sig), enc.encode(data));
  if (!ok) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dec.decode(b64UrlDecode(data)));
  } catch {
    return null;
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { sub: unknown }).sub !== 'string' ||
    typeof (parsed as { exp: unknown }).exp !== 'number'
  ) {
    return null;
  }
  const payload = parsed as SessionPayload;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
};

export const buildSessionCookie = (value: string, ttlSeconds = 7 * 86400): string =>
  `raft_session=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${ttlSeconds}`;

export const clearSessionCookie = (): string =>
  `raft_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
