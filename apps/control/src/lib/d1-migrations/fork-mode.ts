/**
 * Decide how much of the base D1 to copy into the per-PR fork.
 *
 * Export/import is a full logical copy, so very large bases would make
 * provisioning slow and blow the free-tier storage cap. Above the cap we
 * fork **schema only** (`dump_options.no_data`) and say so in the PR comment:
 * the migration preview and schema diff still work, row deltas start at 0.
 */
export type ForkMode = 'full' | 'schema-only';

/** Default cap: 100 MB. Repo config `max_d1_export_size_mb` overrides it. */
export const DEFAULT_FORK_MAX_BYTES = 100 * 1024 * 1024;

export const forkCapBytes = (repoConfig: Record<string, unknown> | undefined): number => {
  const mb = repoConfig?.['max_d1_export_size_mb'];
  return typeof mb === 'number' && mb > 0 ? Math.floor(mb * 1024 * 1024) : DEFAULT_FORK_MAX_BYTES;
};

export const chooseForkMode = (baseSizeBytes: number | undefined, capBytes: number): ForkMode =>
  baseSizeBytes !== undefined && baseSizeBytes > capBytes ? 'schema-only' : 'full';
