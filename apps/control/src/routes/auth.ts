/**
 * /login + /logout — signed-cookie session ergonomics.
 *
 * Free-tier substitution: PRD §8.2 specified Cloudflare Access JWT auth.
 * For demo/free-tier we issue an HMAC-signed `raft_session` cookie after a
 * shared-key login. Production would re-introduce Access via JWT verification.
 *
 * The shared key is `SESSION_SIGNING_KEY` itself (sufficient for a 1-operator
 * demo). Real auth (passwords, magic links) is out of scope.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { apiErr, apiOk } from '@raft/shared-types';
import { buildSessionCookie, clearSessionCookie, signSession } from '../lib/auth/cookies.ts';
import type { ControlAppEnv } from '../app-env.ts';

const loginBody = z.object({
  email: z.string().email().default('admin@raft.dev'),
  key: z.string().min(8),
});

export const authRoutes = new Hono<ControlAppEnv>();

const loginPage = (csrfMsg = ''): string =>
  `<!doctype html><html><head><title>Raft · Login</title>
<script src="https://cdn.tailwindcss.com"></script></head>
<body class="min-h-screen grid place-items-center bg-zinc-950 text-zinc-100 font-mono">
<form method="POST" action="/login" class="space-y-3 w-80">
  <h1 class="text-xl">Raft control plane</h1>
  ${csrfMsg ? `<p class="text-rose-400 text-sm">${csrfMsg}</p>` : ''}
  <label class="block text-xs">Operator email
    <input name="email" type="email" required value="admin@raft.dev"
      class="block w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5"></label>
  <label class="block text-xs">Shared session key (SESSION_SIGNING_KEY)
    <input name="key" type="password" required
      class="block w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5"></label>
  <button class="w-full bg-emerald-600 hover:bg-emerald-500 text-zinc-50 rounded px-3 py-1.5">Log in</button>
</form></body></html>`;

authRoutes.get('/login', (c) =>
  c.html(loginPage()),
);

authRoutes.post('/login', async (c) => {
  const form = await c.req.parseBody();
  const parsed = loginBody.safeParse({ email: form.email, key: form.key });
  if (!parsed.success) {
    return c.html(loginPage('Invalid input'), 400);
  }
  if (parsed.data.key !== c.env.SESSION_SIGNING_KEY) {
    return c.html(loginPage('Wrong shared key'), 401);
  }
  const exp = Math.floor(Date.now() / 1000) + 7 * 86400;
  const cookieValue = await signSession(
    { sub: parsed.data.email, exp },
    c.env.SESSION_SIGNING_KEY,
  );
  c.header('set-cookie', buildSessionCookie(cookieValue));
  return c.redirect('/');
});

authRoutes.post('/logout', (c) => {
  c.header('set-cookie', clearSessionCookie());
  return c.json(apiOk({ logged_out: true }, c.var.requestId));
});

authRoutes.get('/api/v1/whoami', (c) => {
  const session = c.var.session;
  if (!session) return c.json(apiErr('E_AUTH', 'no session', c.var.requestId), 401);
  return c.json(apiOk({ email: session.sub, exp: session.exp }, c.var.requestId));
});
