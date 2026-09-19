/**
 * Read a CF list endpoint's `result` array via the raw client. Returns null
 * (and logs) on any failure so callers can fall through to "create" or
 * treat the account inventory as unknown.
 */
import type { CFClient } from './client.ts';
import type { Logger } from '../logger.ts';

export const readListBody = async (
  client: CFClient,
  log: Logger,
  path: string,
  label: string,
): Promise<unknown[] | null> => {
  const r = await client.raw({ method: 'GET', path });
  if (!r.ok) {
    log.warn('list_failed', { label, error: r.error.message });
    return null;
  }
  try {
    const data = JSON.parse(await r.value.text()) as { result?: unknown };
    return Array.isArray(data.result) ? data.result : null;
  } catch (e) {
    log.warn('list_parse_failed', { label, error: String(e) });
    return null;
  }
};
