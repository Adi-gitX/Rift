/**
 * CF API mock used as miniflare's outboundService in tests.
 *
 * Intercepts every outbound fetch from the worker (including from inside
 * Durable Objects), routes the standard Cloudflare API endpoints to
 * deterministic stubs, and returns 599 for anything unrecognized so that
 * accidental real-network calls fail loudly.
 */

const cfOk = (result: unknown): Response =>
  new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

export const cfApiOutboundMock = async (request: Request): Promise<Response> => {
  const url = request.url;

  if (url.includes('/d1/database') && !url.includes('/import') && !url.includes('/export')) {
    if (request.method === 'POST') return cfOk({ uuid: 'd1-uuid-mock', name: 'mock-d1' });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.includes('/storage/kv/namespaces')) {
    if (request.method === 'POST') return cfOk({ id: 'kv-id-mock', title: 'mock-kv' });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.includes('/queues') && !url.includes('/consumers')) {
    if (request.method === 'POST') return cfOk({ queue_id: 'q-id-mock', queue_name: 'mock-q' });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.includes('/workers/scripts/')) {
    if (request.method === 'PUT') return cfOk({ id: 'mock-script', etag: 'e-mock' });
    if (request.method === 'DELETE') return cfOk({});
  }
  if (url.includes('/r2/buckets/') && url.endsWith('/lifecycle')) {
    return cfOk({});
  }

  return new Response(`outbound not mocked: ${request.method} ${url}`, { status: 599 });
};
