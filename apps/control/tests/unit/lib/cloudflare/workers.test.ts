import { describe, expect, it, vi } from 'vitest';
import { CFClient } from '../../../../src/lib/cloudflare/client.ts';
import {
  buildScriptName,
  deleteScript,
  uploadScript,
  validateScriptName,
} from '../../../../src/lib/cloudflare/workers.ts';

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
  });

const mkClient = (fetcher: typeof fetch) =>
  new CFClient({ accountId: 'a', token: 't', fetcher, baseDelayMs: 0 });

describe('cloudflare/workers', () => {
  it('uploadScript PUTs multipart with metadata + module', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({ id: 'raft-x', etag: 'e1' }));
    const r = await uploadScript(mkClient(fetcher), {
      scriptName: 'raft-x-y-pr-1',
      mainModule: 'worker.js',
      modules: [{ name: 'worker.js', content: 'export default { fetch(){} }', contentType: 'application/javascript+module' }],
      compatibilityDate: '2026-04-29',
      bindings: [{ type: 'd1', name: 'DB', id: 'd1-uuid' }],
    });
    expect(r.ok).toBe(true);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(init.body).toBeInstanceOf(FormData);
    expect(fetcher.mock.calls[0]![0]).toContain('/workers/scripts/raft-x-y-pr-1');
  });

  it('deleteScript DELETEs /workers/scripts/:name', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({}));
    const r = await deleteScript(mkClient(fetcher), 'raft-x-y-pr-1');
    expect(r.ok).toBe(true);
    expect((fetcher.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('validateScriptName rejects bad names', () => {
    expect(validateScriptName('raft-x-y-pr-1')).toBe(true);
    expect(validateScriptName('')).toBe(false);
    expect(validateScriptName('Bad name with spaces')).toBe(false);
    expect(validateScriptName('a'.repeat(64))).toBe(false);
    expect(validateScriptName('-startshyphen')).toBe(false);
  });

  it('buildScriptName produces a valid name within 63 chars', () => {
    const name = buildScriptName('install', 'acmeapi', 42);
    expect(name).toBe('raft-install-acmeapi-pr-42');
    expect(validateScriptName(name)).toBe(true);
  });
});
