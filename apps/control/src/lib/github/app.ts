/**
 * GitHub App auth: produces installation tokens.
 *  - signs an RS256 JWT (10-min lifetime) for the App,
 *  - exchanges it at POST /app/installations/:id/access_tokens,
 *  - caches the resulting installation token in KV (TTL = 50 min,
 *    GitHub install tokens live 60 min, we leave 10 min headroom).
 */
import { signJwtRs256 } from '../crypto/jwt.ts';

const GH_API = 'https://api.github.com';

interface InstallationTokenResponse {
  token: string;
  expires_at: string;
}

const tokenKey = (installationId: string): string => `gh:install-token:${installationId}`;

export interface GithubAppAuth {
  appId: string;
  privateKeyPem: string;
}

const mintAppJwt = async (auth: GithubAppAuth): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return signJwtRs256(auth.privateKeyPem, {
    iat: now - 30,
    exp: now + 9 * 60,
    iss: auth.appId,
  });
};

export const fetchInstallationTokenFresh = async (
  auth: GithubAppAuth,
  installationId: string,
): Promise<{ token: string; expiresAt: number }> => {
  const jwt = await mintAppJwt(auth);
  const res = await fetch(`${GH_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'raft-control',
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`github installation_token failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as InstallationTokenResponse;
  return { token: data.token, expiresAt: Date.parse(data.expires_at) / 1000 };
};

export const getInstallationToken = async (
  cache: KVNamespace,
  auth: GithubAppAuth,
  installationId: string,
): Promise<string> => {
  const cached = await cache.get(tokenKey(installationId));
  if (cached) return cached;
  const { token, expiresAt } = await fetchInstallationTokenFresh(auth, installationId);
  const ttlSeconds = Math.max(60, expiresAt - Math.floor(Date.now() / 1000) - 600);
  await cache.put(tokenKey(installationId), token, { expirationTtl: ttlSeconds });
  return token;
};
