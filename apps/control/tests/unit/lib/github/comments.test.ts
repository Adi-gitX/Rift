/**
 * Unit tests for the sticky-comment upsert helper.
 *
 * The behaviour we care about:
 *  - PATCH `knownCommentId` directly when supplied (cheapest path).
 *  - On 404 from PATCH (operator deleted the comment), fall through to
 *    LIST → match by marker → PATCH the matching one.
 *  - When no marker match exists, POST a fresh comment.
 *  - The body always carries the marker so future calls can find it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { upsertStickyComment } from '../../../../src/lib/github/comments.ts';

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const installFetch = (impl: (req: Request) => Response | Promise<Response>): ReturnType<typeof vi.fn> => {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return impl(req);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = mock;
  return mock;
};

const baseInput = {
  token: 't',
  ownerRepo: 'o/r',
  issueNumber: 7,
  body: 'preview body',
  marker: 'preview',
};

describe('upsertStickyComment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('PATCHes knownCommentId directly when supplied (no LIST round-trip)', async () => {
    const calls: string[] = [];
    installFetch((req) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      return jsonResponse(200, { id: 999, body: 'patched' });
    });
    const r = await upsertStickyComment({ ...baseInput, knownCommentId: 999 });
    expect(r.commentId).toBe(999);
    expect(r.created).toBe(false);
    expect(calls).toEqual(['PATCH /repos/o/r/issues/comments/999']);
    expect(r.finalBody).toContain('<!-- raft:preview -->');
  });

  it('falls through to LIST → PATCH when knownCommentId 404s (operator deleted)', async () => {
    const calls: string[] = [];
    installFetch((req) => {
      calls.push(`${req.method} ${new URL(req.url).pathname}`);
      const path = new URL(req.url).pathname;
      if (path === '/repos/o/r/issues/comments/123' && req.method === 'PATCH') {
        return jsonResponse(404, { message: 'Not Found' });
      }
      if (path === '/repos/o/r/issues/7/comments' && req.method === 'GET') {
        return jsonResponse(200, [
          { id: 11, body: 'unrelated' },
          { id: 22, body: 'something\n\n<!-- raft:preview -->' },
        ]);
      }
      if (path === '/repos/o/r/issues/comments/22' && req.method === 'PATCH') {
        return jsonResponse(200, { id: 22, body: req.body ? 'updated' : '' });
      }
      throw new Error(`unexpected: ${req.method} ${path}`);
    });
    const r = await upsertStickyComment({ ...baseInput, knownCommentId: 123 });
    expect(r.commentId).toBe(22);
    expect(r.created).toBe(false);
    expect(calls).toEqual([
      'PATCH /repos/o/r/issues/comments/123',
      'GET /repos/o/r/issues/7/comments',
      'PATCH /repos/o/r/issues/comments/22',
    ]);
  });

  it('LISTs and PATCHes when marker exists and no knownCommentId is supplied', async () => {
    installFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith('/issues/7/comments') && req.method === 'GET') {
        return jsonResponse(200, [{ id: 55, body: 'old\n\n<!-- raft:preview -->' }]);
      }
      if (path === '/repos/o/r/issues/comments/55' && req.method === 'PATCH') {
        return jsonResponse(200, { id: 55, body: 'updated' });
      }
      throw new Error(`unexpected: ${req.method} ${path}`);
    });
    const r = await upsertStickyComment(baseInput);
    expect(r.commentId).toBe(55);
    expect(r.created).toBe(false);
  });

  it('POSTs a new comment when no marker match exists', async () => {
    installFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith('/issues/7/comments') && req.method === 'GET') {
        return jsonResponse(200, [{ id: 1, body: 'unrelated' }]);
      }
      if (path === '/repos/o/r/issues/7/comments' && req.method === 'POST') {
        return jsonResponse(201, { id: 999, body: 'created' });
      }
      throw new Error(`unexpected: ${req.method} ${path}`);
    });
    const r = await upsertStickyComment(baseInput);
    expect(r.commentId).toBe(999);
    expect(r.created).toBe(true);
  });

  it('appends the marker to the posted body so a future call can find it', async () => {
    let postedBody = '';
    installFetch((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith('/issues/7/comments') && req.method === 'GET') return jsonResponse(200, []);
      if (req.method === 'POST') {
        // capture body
        return req
          .json()
          .then((b: unknown) => {
            postedBody = (b as { body: string }).body;
            return jsonResponse(201, { id: 1, body: postedBody });
          });
      }
      throw new Error('unexpected');
    });
    await upsertStickyComment(baseInput);
    expect(postedBody).toContain('preview body');
    expect(postedBody).toContain('<!-- raft:preview -->');
  });

  it('rethrows non-404 errors from the knownCommentId PATCH (e.g. 401 token expired)', async () => {
    installFetch((_req) => jsonResponse(401, { message: 'Bad credentials' }));
    await expect(
      upsertStickyComment({ ...baseInput, knownCommentId: 1 }),
    ).rejects.toThrow(/401/);
  });
});
