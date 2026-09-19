/**
 * CF API mock used as miniflare's outboundService in tests.
 *
 * Intercepts every outbound fetch from the worker (including from inside
 * Durable Objects), routes the standard Cloudflare API endpoints to
 * deterministic stubs, and returns 599 for anything unrecognized so that
 * accidental real-network calls fail loudly.
 *
 * D1 `/query`, export and import are backed by tests/fake-d1.ts so the
 * migration-preview steps run against a real (if tiny) schema model; GitHub
 * trees/blobs/comments are backed by tests/fake-github.ts.
 */
import { dumpSql, handleFakeD1Admin, ingestSql, runQuery } from './fake-d1.ts';
import { handleFakeGithub } from './fake-github.ts';

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 48);

const handleD1 = async (request: Request, url: URL): Promise<Response | null> => {
  let m: RegExpExecArray | null;
  if ((m = /\/d1\/database\/([^/]+)\/query$/.exec(url.pathname)) && request.method === 'POST') {
    const body = (await request.json()) as { sql: string; params?: unknown[] };
    return runQuery(m[1] ?? '', body.sql, body.params);
  }
  if ((m = /\/d1\/database\/([^/]+)\/export$/.exec(url.pathname)) && request.method === 'POST') {
    return cfOk({
      status: 'complete',
      at_bookmark: 'bm-1',
      signed_url: `https://mock-export.local/dump.sql?db=${encodeURIComponent(m[1] ?? '')}`,
    });
  }
  if ((m = /\/d1\/database\/([^/]+)\/import$/.exec(url.pathname)) && request.method === 'POST') {
    const body = (await request.json()) as { action: string };
    const db = m[1] ?? '';
    if (body.action === 'init') {
      return cfOk({
        upload_url: `https://mock-upload.local/u?db=${encodeURIComponent(db)}`,
        filename: 'dump.sql',
      });
    }
    return cfOk({ status: 'complete', at_bookmark: 'bm-2', success: true });
  }
  if (url.pathname.endsWith('/d1/database') && request.method === 'POST') {
    const body = (await request.json()) as { name?: string };
    const name = body.name ?? 'mock-d1';
    return cfOk({ uuid: `d1-${slug(name)}`, name });
  }
  if (/\/d1\/database\/[^/]+$/.test(url.pathname) && request.method === 'DELETE') return cfOk({});
  return null;
};

export const cfApiOutboundMock = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);

  const admin = await handleFakeD1Admin(request);
  if (admin) return admin;
  const gh = await handleFakeGithub(request);
  if (gh) return gh;

  if (url.hostname === 'mock-export.local') {
    return new Response(dumpSql(url.searchParams.get('db') ?? ''), {
      headers: { 'content-type': 'application/sql' },
    });
  }
  if (url.hostname === 'mock-upload.local' && request.method === 'PUT') {
    try {
      ingestSql(url.searchParams.get('db') ?? '', await request.text());
    } catch (e) {
      return new Response(String(e), { status: 400 });
    }
    return new Response('ok');
  }

  if (url.pathname.includes('/d1/database')) {
    const r = await handleD1(request, url);
    if (r) return r;
  }
  if (url.pathname.includes('/storage/kv/namespaces')) {
    if (request.method === 'POST') return cfOk({ id: 'kv-id-mock', title: 'mock-kv' });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.pathname.includes('/queues') && !url.pathname.includes('/consumers')) {
    if (request.method === 'POST') return cfOk({ queue_id: 'q-id-mock', queue_name: 'mock-q' });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.pathname.includes('/workers/scripts/')) {
    if (request.method === 'PUT') return cfOk({ id: 'mock-script', etag: 'e-mock' });
    if (request.method === 'POST') return cfOk({ enabled: true });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.pathname.includes('/r2/buckets/') && url.pathname.endsWith('/lifecycle')) {
    return cfOk({});
  }
  // Live-preview probe from route-and-comment: `https://<script>.<subdomain>/`.
  if (url.hostname.endsWith('.raft-test.workers.dev')) {
    return new Response('preview ok', { status: 200 });
  }

  return new Response(`outbound not mocked: ${request.method} ${url.toString()}`, { status: 599 });
};
