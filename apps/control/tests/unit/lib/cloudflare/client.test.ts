import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CFClient } from '../../../../src/lib/cloudflare/client.ts';

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const cfFail = (code: number, body = 'oops'): Response =>
  new Response(body, { status: code });

const sampleSchema = z.object({ id: z.string() });

const makeClient = (fetcher: typeof fetch) =>
  new CFClient({ accountId: 'acct', token: 'cf-tok', fetcher, baseDelayMs: 0 });

describe('CFClient.req', () => {
  it('happy path: parses envelope and returns result', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({ id: 'abc' }));
    const c = makeClient(fetcher);
    const r = await c.req({ method: 'GET', path: '/x' }, sampleSchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe('abc');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toContain('/accounts/acct/x');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer cf-tok' });
  });

  it('retries on 429', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfFail(429))
      .mockResolvedValueOnce(cfOk({ id: 'r' }));
    const c = makeClient(fetcher);
    const r = await c.req({ method: 'GET', path: '/x' }, sampleSchema);
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries on 502 then 503 then succeeds', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(cfFail(502))
      .mockResolvedValueOnce(cfFail(503))
      .mockResolvedValueOnce(cfOk({ id: 'r' }));
    const c = makeClient(fetcher);
    const r = await c.req({ method: 'GET', path: '/x' }, sampleSchema);
    expect(r.ok).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 400', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfFail(400, 'bad'));
    const c = makeClient(fetcher);
    const r = await c.req({ method: 'POST', path: '/x', body: { a: 1 } }, sampleSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('E_CF_API');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries on persistent 5xx', async () => {
    const fetcher = vi.fn().mockResolvedValue(cfFail(500));
    const c = new CFClient({ accountId: 'a', token: 't', fetcher, baseDelayMs: 0, maxRetries: 2 });
    const r = await c.req({ method: 'GET', path: '/x' }, sampleSchema);
    expect(r.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('handles envelope success=false as a non-retried failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, errors: [{ code: 7000, message: 'denied' }], messages: [], result: null }),
        { status: 200 },
      ),
    );
    const c = makeClient(fetcher);
    const r = await c.req({ method: 'GET', path: '/x' }, sampleSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toBe('cf_envelope_failed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serializes JSON body and sets content-type', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({ id: 'x' }));
    const c = makeClient(fetcher);
    await c.req({ method: 'POST', path: '/x', body: { name: 'n' } }, sampleSchema);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe('{"name":"n"}');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('passes FormData through unchanged (no JSON serialization)', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(cfOk({ id: 'x' }));
    const c = makeClient(fetcher);
    const fd = new FormData();
    fd.append('a', 'b');
    await c.req({ method: 'PUT', path: '/x', body: fd }, sampleSchema);
    const init = fetcher.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('respects noRetry option', async () => {
    const fetcher = vi.fn().mockResolvedValue(cfFail(500));
    const c = makeClient(fetcher);
    const r = await c.req({ method: 'POST', path: '/x', body: {}, noRetry: true }, sampleSchema);
    expect(r.ok).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
