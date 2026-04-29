/**
 * raft-dispatcher Worker (Slice F, free-tier path).
 *
 *   GET /                    → index page (preview link discovery)
 *   * /<scope>/<rest...>     → forward to <scriptName>.<workers-subdomain>/<rest>
 *
 * The internal shared secret is forwarded so the user worker can
 * confirm the request came from raft (defence-in-depth — the script's
 * own *.workers.dev URL is publicly reachable too).
 */
interface DispatcherEnv {
  readonly ROUTES: KVNamespace;
  readonly CF_WORKERS_SUBDOMAIN: string;
  readonly RAFT_BASE_DOMAIN: string;
  readonly INTERNAL_DISPATCH_SECRET: string;
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
]);

const indexHtml = (origin: string): string =>
  `<!doctype html><title>raft-dispatcher</title>
<style>body{font:14px ui-monospace,monospace;max-width:48em;margin:3em auto;color:#222}</style>
<h1>raft-dispatcher</h1>
<p>Per-PR preview proxy. Reach a PR preview at:</p>
<pre>${origin}/&lt;scope&gt;/&lt;your-path&gt;</pre>
<p>where <code>&lt;scope&gt;</code> is the per-PR key (e.g. <code>pr-1--acmeapi</code>) — the
ProvisionRunner posts the full URL as a sticky comment on the PR.</p>`;

const cleanForwardedHeaders = (req: Request, secret: string): Headers => {
  const headers = new Headers(req.headers);
  for (const name of Array.from(headers.keys())) {
    if (HOP_BY_HOP.has(name.toLowerCase())) headers.delete(name);
  }
  headers.set('x-raft-internal', secret);
  headers.set('x-forwarded-host', req.headers.get('host') ?? '');
  return headers;
};

const handler: ExportedHandler<DispatcherEnv> = {
  async fetch(req, env, _ctx) {
    const url = new URL(req.url);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return new Response(indexHtml(url.origin), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    const scope = segments[0];
    if (!scope) return new Response('Bad request', { status: 400 });
    const scriptName = await env.ROUTES.get(`route:${scope}`);
    if (!scriptName) {
      return new Response(`No preview for ${scope}`, { status: 404 });
    }
    const rest = segments.slice(1).join('/');
    const target = new URL(
      `https://${scriptName}.${env.CF_WORKERS_SUBDOMAIN}/${rest}${url.search}`,
    );
    const init: RequestInit = {
      method: req.method,
      headers: cleanForwardedHeaders(req, env.INTERNAL_DISPATCH_SECRET),
      redirect: 'manual',
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') init.body = req.body;
    return fetch(target, init);
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
