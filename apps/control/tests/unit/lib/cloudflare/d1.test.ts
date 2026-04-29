import { describe, expect, it, vi } from 'vitest';
import { CFClient } from '../../../../src/lib/cloudflare/client.ts';
import {
  createDatabase,
  deleteDatabase,
  importSqlAndWait,
  initImport,
  ingestImport,
} from '../../../../src/lib/cloudflare/d1.ts';

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
  });

const mkClient = (fetcher: typeof fetch) =>
  new CFClient({ accountId: 'a', token: 't', fetcher, baseDelayMs: 0 });

describe('cloudflare/d1', () => {
  it('createDatabase returns the new uuid', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({ uuid: 'd1-uuid', name: 'x' }));
    const r = await createDatabase(mkClient(fetcher), 'x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.uuid).toBe('d1-uuid');
    expect(fetcher.mock.calls[0]![0]).toContain('/d1/database');
  });

  it('deleteDatabase issues DELETE on /d1/database/:id', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({}));
    const r = await deleteDatabase(mkClient(fetcher), 'd1-uuid');
    expect(r.ok).toBe(true);
    expect(fetcher.mock.calls[0]![0]).toContain('/d1/database/d1-uuid');
    expect((fetcher.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });

  it('initImport returns upload_url + filename', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfOk({ upload_url: 'https://r2.example/upload', filename: 'f.sql' }));
    const r = await initImport(mkClient(fetcher), 'd1-x', 'etag-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.upload_url).toBe('https://r2.example/upload');
      expect(r.value.filename).toBe('f.sql');
    }
  });

  it('ingestImport posts the action+etag+filename body', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({ status: 'complete' }));
    await ingestImport(mkClient(fetcher), 'd1-x', 'etag', 'fname');
    const body = (fetcher.mock.calls[0]![1] as RequestInit).body as string;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(parsed.action).toBe('ingest');
    expect(parsed.etag).toBe('etag');
    expect(parsed.filename).toBe('fname');
  });

  it('importSqlAndWait runs init → upload → ingest happy path', async () => {
    const fetcher = vi.fn();
    fetcher.mockResolvedValueOnce(cfOk({ upload_url: 'https://r2.example/u', filename: 'f' }));
    fetcher.mockResolvedValueOnce(new Response('', { status: 200 }));
    fetcher.mockResolvedValueOnce(cfOk({ status: 'complete' }));
    const r = await importSqlAndWait(mkClient(fetcher), 'd1-x', 'CREATE TABLE t(x);', 'etag');
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]![0]).toBe('https://r2.example/u');
  });
});
