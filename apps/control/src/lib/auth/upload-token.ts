/**
 * Per-repo upload tokens (PRD amendment A6).
 *  - 32 random bytes, base64url-encoded, prefixed `raft_ut_`.
 *  - Stored hashed (SHA-256, base64url) in `repos.upload_token_hash`.
 *  - Plaintext shown to the user once on rotation; never logged.
 *  - Verification is constant-time (string-length-equal then XOR).
 */
const TOKEN_PREFIX = 'raft_ut_';
const TOKEN_RAW_BYTES = 32;
const TOKEN_PATTERN = /^raft_ut_[A-Za-z0-9_-]{40,80}$/;

const enc = new TextEncoder();

const b64UrlBytes = (bytes: Uint8Array): string => {
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const isUploadTokenShape = (token: string): boolean => TOKEN_PATTERN.test(token);

export const mintUploadToken = (): string => {
  const bytes = new Uint8Array(TOKEN_RAW_BYTES);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + b64UrlBytes(bytes);
};

export const hashUploadToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return b64UrlBytes(new Uint8Array(digest));
};

export const verifyUploadToken = async (
  presented: string,
  storedHash: string,
): Promise<boolean> => {
  if (!isUploadTokenShape(presented)) return false;
  const computed = await hashUploadToken(presented);
  if (computed.length !== storedHash.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ storedHash.charCodeAt(i);
  }
  return diff === 0;
};
