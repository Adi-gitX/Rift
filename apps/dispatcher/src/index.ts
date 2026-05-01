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

/**
 * Compute a short HMAC-SHA256 token for the given scope. The synthesized
 * static worker (and any customer worker that opts in) verifies this
 * before serving content. Without the token, the bare *.workers.dev URL
 * is unauth'd and could be hit by anyone with the script name.
 *
 * 16-byte tag truncation keeps the URL short while staying well above
 * brute-force-feasible.
 */
const signScope = async (scope: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`raft-preview:${scope}`)));
  // base64url, first 16 bytes.
  let s = '';
  for (let i = 0; i < 16; i++) s += String.fromCharCode(sig[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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
    // Append the per-scope auth token + a Set-Cookie on the redirect, so
    // subsequent navigation under the user worker keeps the cookie (browser
    // honours Set-Cookie on 3xx). The query param doubles as the first-hit
    // gate for clients that don't store cookies.
    const token = await signScope(scope, env.INTERNAL_DISPATCH_SECRET);
    const sep = url.search ? '&' : (rest.includes('?') ? '&' : '?');
    const search = url.search ? `${url.search}${sep}raft_t=${token}` : `?raft_t=${token}`;
    const target = `https://${scriptName}.${env.CF_WORKERS_SUBDOMAIN}/${rest}${search}`;
    const headers = new Headers({ location: target });
    headers.append(
      'set-cookie',
      `raft_t=${token}; Path=/; Max-Age=86400; SameSite=Lax; Secure`,
    );
    return new Response(null, { status: 302, headers });
  },
};

// eslint-disable-next-line import-x/no-default-export -- Workers entrypoint.
export default handler;
