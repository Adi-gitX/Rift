/**
 * Multi-tenant Cloudflare credentials.
 *
 * Each GitHub installation may connect its own Cloudflare account: the API
 * token is stored AES-GCM-encrypted in `installations.cloudflare_token_secret_id`
 * and the account id + workers.dev subdomain alongside it. Runners resolve
 * credentials per installation; anything not connected falls back to the
 * operator's shared token (`CF_API_TOKEN`) so the demo keeps working.
 */
import type { Env } from '../env.ts';
import { getInstallation } from './db/installations.ts';
import { decryptString, encryptString } from './crypto/aes.ts';

export interface CloudflareCredentials {
  accountId: string;
  token: string;
  /** e.g. `acme.workers.dev` — where per-PR scripts become reachable. */
  workersSubdomain: string;
  source: 'installation' | 'shared';
}

/** Master key for token encryption; a dedicated secret if set, else the session key. */
export const tokenMasterKey = (env: Env): string =>
  env.RAFT_TOKEN_ENCRYPTION_KEY ?? env.SESSION_SIGNING_KEY;

export const sharedCredentials = (env: Env): CloudflareCredentials => ({
  accountId: env.CF_OWN_ACCOUNT_ID,
  token: env.CF_API_TOKEN,
  workersSubdomain: env.CF_WORKERS_SUBDOMAIN,
  source: 'shared',
});

export const resolveCloudflareCredentials = async (
  env: Env,
  installationId: string,
): Promise<CloudflareCredentials> => {
  const shared = sharedCredentials(env);
  const r = await getInstallation(env.DB, installationId);
  if (!r.ok || !r.value?.cloudflareAccountId || !r.value.cloudflareTokenSecretId) return shared;
  try {
    const token = await decryptString(tokenMasterKey(env), r.value.cloudflareTokenSecretId);
    const sub = r.value.config['workersSubdomain'];
    return {
      accountId: r.value.cloudflareAccountId,
      token,
      workersSubdomain: typeof sub === 'string' && sub.length > 0 ? sub : shared.workersSubdomain,
      source: 'installation',
    };
  } catch {
    // Key rotated or row corrupted — degrade to shared rather than stall the PR.
    return shared;
  }
};

export const sealToken = (env: Env, token: string): Promise<string> =>
  encryptString(tokenMasterKey(env), token);

/**
 * Prove a token can do what provisioning needs on the given account: list
 * Workers scripts (Workers Scripts:Read is implied by :Edit) and D1 databases.
 */
export const verifyCloudflareToken = async (
  accountId: string,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  for (const path of ['/workers/scripts?per_page=1', '/d1/database?per_page=1']) {
    const res = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return { ok: false, reason: `${path.split('?')[0]} → HTTP ${res.status}` };
  }
  return { ok: true };
};
