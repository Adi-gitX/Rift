/**
 * Read repository contents at a specific commit using a GitHub App
 * installation token. Used by the static-site synthesizer to materialise
 * a Worker bundle from the customer's repo without requiring them to set
 * up a build pipeline.
 *
 *   - getRepoTree:  GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1
 *   - getRepoBlob:  GET /repos/{owner}/{repo}/git/blobs/{sha}
 *
 * Both calls return JSON. Blob payloads are base64-encoded.
 */
const GH_API = 'https://api.github.com';

const ghHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'raft-control',
  'x-github-api-version': '2022-11-28',
});

export interface RepoTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

export interface RepoTree {
  sha: string;
  tree: RepoTreeEntry[];
  truncated: boolean;
}

export const getRepoTree = async (
  token: string,
  ownerRepo: string,
  sha: string,
): Promise<RepoTree> => {
  const url = `${GH_API}/repos/${ownerRepo}/git/trees/${sha}?recursive=1`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`github get_tree failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<RepoTree>;
};

export interface RepoBlob {
  sha: string;
  size: number;
  /** Base64-encoded; may have embedded `\n` per RFC 2045. */
  content: string;
  encoding: 'base64' | 'utf-8';
}

export const getRepoBlob = async (
  token: string,
  ownerRepo: string,
  blobSha: string,
): Promise<RepoBlob> => {
  const url = `${GH_API}/repos/${ownerRepo}/git/blobs/${blobSha}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    throw new Error(`github get_blob failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<RepoBlob>;
};

/**
 * Convenience: fetch a single file's bytes by repo path at a given commit.
 * Walks the tree once, then fetches the matching blob. Throws if the path
 * isn't found.
 */
export const getRepoFileBytes = async (
  token: string,
  ownerRepo: string,
  sha: string,
  path: string,
): Promise<Uint8Array> => {
  const tree = await getRepoTree(token, ownerRepo, sha);
  const entry = tree.tree.find((e) => e.path === path && e.type === 'blob');
  if (!entry) throw new Error(`path not found in repo tree: ${path}`);
  const blob = await getRepoBlob(token, ownerRepo, entry.sha);
  return base64ToBytes(blob.content);
};

export const base64ToBytes = (b64: string): Uint8Array => {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
