/**
 * raft-dispatcher Worker (Slice F, free-tier path).
 *
 *   GET /                    → index page (preview link discovery)
 *   * /<scope>/<rest...>     → 302 → <scriptName>.<workers-subdomain>/<rest>
 *
 * Why a redirect, not a proxy: a Worker fetch()-ing another Worker on
 * the same *.workers.dev account subdomain is routed internally by the
 * Cloudflare edge and returns the empty-subdomain placeholder, even
 * when the target script's subdomain is enabled and serves real
 * content from the public internet. Redirecting is the only reliable
 * free-tier path. INTERNAL_DISPATCH_SECRET stays in env for parity
 * with the production proxy mode but is no longer forwarded.
 */
interface DispatcherEnv {
  readonly ROUTES: KVNamespace;
  readonly CF_WORKERS_SUBDOMAIN: string;
  readonly RAFT_BASE_DOMAIN: string;
  readonly INTERNAL_DISPATCH_SECRET: string;
}

const indexHtml = (origin: string): string =>
  `<!doctype html><title>raft-dispatcher</title>
<style>body{font:14px ui-monospace,monospace;max-width:48em;margin:3em auto;color:#222}</style>
<h1>raft-dispatcher</h1>
<p>Per-PR preview proxy. Reach a PR preview at:</p>
<pre>${origin}/&lt;scope&gt;/&lt;your-path&gt;</pre>
<p>where <code>&lt;scope&gt;</code> is the per-PR key (e.g. <code>pr-1--acmeapi</code>) — the
ProvisionRunner posts the full URL as a sticky comment on the PR. Requests
are 302-redirected to the per-PR Worker's <code>*.workers.dev</code> URL.</p>`;

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
    const target = `https://${scriptName}.${env.CF_WORKERS_SUBDOMAIN}/${rest}${url.search}`;
    return Response.redirect(target, 302);
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
