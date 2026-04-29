/**
 * Minimal RS256 JWT signer for the GitHub App (Web Crypto, no deps).
 * Only signs; verification is the JWKS path in lib/auth.
 */
import { pemToBytes } from './pem.ts';

const enc = new TextEncoder();

const b64UrlFromBytes = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const byte of view) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64UrlFromString = (s: string): string => b64UrlFromBytes(enc.encode(s));

export interface JwtClaims extends Record<string, unknown> {
  iat: number;
  exp: number;
  iss: string;
}

const importPrivateKey = (pem: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'pkcs8',
    pemToBytes(pem) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );

export const signJwtRs256 = async (privateKeyPem: string, claims: JwtClaims): Promise<string> => {
  const header = b64UrlFromString(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64UrlFromString(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(data));
  return `${data}.${b64UrlFromBytes(sig)}`;
};
