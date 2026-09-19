/**
 * KV key for a customer-uploaded bundle in BUNDLES_KV.
 *
 * Shared by the upload endpoint (routes/api.ts), the provision runner's
 * `await-bundle` step, and the teardown runner's `purge-bundle-kv` step.
 * Keep it in one place — if these ever diverge the runner cannot find what
 * the GitHub Action just pushed, and teardown leaves blobs behind.
 */
export const bundleKvKey = (
  installationId: string,
  repoFullName: string,
  headSha: string,
): string => `bundle:${installationId}:${repoFullName}:${headSha}`;
