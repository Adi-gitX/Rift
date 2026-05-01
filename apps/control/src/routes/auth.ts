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

/**
 * Operator login page. Self-contained — no external CDN, no framework
 * payload. Single HTML response, server-rendered. Dark theme matches the
 * rest of the dashboard. The grid backdrop is pure CSS (no JS animations,
 * no images) so it loads instantly.
 */
const loginPage = (errorMsg = ''): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Raft Control · Sign in</title>
<style>
  *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --ink:        #050505;
    --surface:    #0a0a0a;
    --surface-2:  #111111;
    --border:     rgba(255,255,255,0.06);
    --border-hi:  rgba(255,255,255,0.14);
    --text:       #ededed;
    --text-dim:   #8a8a8a;
    --text-faint: #555555;
    --accent:     #ED462D;
    --accent-dim: rgba(237,70,45,0.16);
    --danger:     #ff8a75;
  }
  html, body { height: 100%; background: var(--ink); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  body {
    min-height: 100vh; display: grid; grid-template-rows: 1fr auto;
    position: relative; overflow: hidden;
  }
  /* Grid backdrop — perspective-projected, faint, fades to ink at edges. */
  .grid-bg {
    position: absolute; inset: 0; pointer-events: none; z-index: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 56px 56px;
    mask-image: radial-gradient(ellipse 60% 80% at 50% 40%, #000 30%, transparent 80%);
    -webkit-mask-image: radial-gradient(ellipse 60% 80% at 50% 40%, #000 30%, transparent 80%);
  }
  .accent-orb {
    position: absolute; left: 50%; top: 38%; transform: translate(-50%,-50%);
    width: 540px; height: 540px; pointer-events: none; z-index: 0;
    background: radial-gradient(circle at center, rgba(237,70,45,0.22), transparent 60%);
    filter: blur(40px);
  }

  main {
    position: relative; z-index: 1;
    display: grid; place-items: center; padding: 48px 24px;
  }
  .card {
    width: 100%; max-width: 380px;
    background: rgba(10,10,10,0.72);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 36px 32px 28px;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 24px 48px -16px rgba(0,0,0,0.6);
  }
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 28px; }
  .brand .mark {
    width: 24px; height: 24px; border-radius: 5px;
    display: grid; place-items: center;
    background: linear-gradient(135deg, var(--accent) 0%, #c43719 100%);
    box-shadow: 0 0 0 1px rgba(255,255,255,0.06) inset, 0 4px 12px rgba(237,70,45,0.35);
  }
  .brand .mark::after {
    content: ""; width: 8px; height: 8px; border-radius: 50%;
    background: rgba(255,255,255,0.9);
    box-shadow: 0 0 8px rgba(255,255,255,0.6);
  }
  .brand .name { font-weight: 600; letter-spacing: -0.01em; font-size: 15px; }
  .brand .name .light { color: var(--text-dim); font-weight: 400; margin-left: 6px; }

  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.015em; margin-bottom: 6px; }
  .subtitle { font-size: 13px; color: var(--text-dim); line-height: 1.55; margin-bottom: 26px; }

  .err {
    border: 1px solid rgba(255,138,117,0.3);
    background: rgba(255,138,117,0.06);
    color: var(--danger);
    padding: 8px 12px; border-radius: 8px;
    font-size: 12px; margin-bottom: 16px;
    display: flex; align-items: center; gap: 8px;
  }
  .err::before { content: ""; display: inline-block; width: 4px; height: 4px; background: var(--danger); border-radius: 50%; }

  form { display: flex; flex-direction: column; gap: 14px; }
  label { display: block; font-size: 11.5px; font-weight: 500; color: var(--text-dim); margin-bottom: 6px; letter-spacing: 0.02em; }
  .field input {
    display: block; width: 100%; appearance: none;
    background: rgba(0,0,0,0.4); border: 1px solid var(--border);
    color: var(--text); font-family: inherit; font-size: 13.5px;
    padding: 10px 12px; border-radius: 8px;
    transition: border-color 120ms ease, background-color 120ms ease;
  }
  .field input::placeholder { color: var(--text-faint); }
  .field input:hover { border-color: var(--border-hi); }
  .field input:focus { outline: none; border-color: var(--accent); background: rgba(0,0,0,0.55); box-shadow: 0 0 0 3px var(--accent-dim); }

  button[type=submit] {
    margin-top: 6px; appearance: none; cursor: pointer;
    width: 100%; padding: 11px 16px; border: 0; border-radius: 8px;
    background: linear-gradient(180deg, var(--accent) 0%, #d3401f 100%);
    color: white; font-family: inherit; font-size: 13.5px; font-weight: 600;
    letter-spacing: 0.01em;
    box-shadow: 0 1px 0 rgba(255,255,255,0.18) inset, 0 8px 16px -4px rgba(237,70,45,0.4);
    transition: transform 80ms ease, filter 80ms ease;
  }
  button[type=submit]:hover { filter: brightness(1.05); }
  button[type=submit]:active { transform: translateY(1px); }
  button[type=submit]:focus-visible { outline: 2px solid white; outline-offset: 2px; }

  .meta {
    margin-top: 24px; padding-top: 18px;
    border-top: 1px solid var(--border);
    font-size: 11.5px; color: var(--text-faint); line-height: 1.6;
  }
  .meta code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    background: rgba(255,255,255,0.04); padding: 1px 6px; border-radius: 4px;
    color: var(--text-dim); font-size: 11px;
  }
  .meta a { color: var(--text-dim); text-decoration: none; border-bottom: 1px dotted var(--text-faint); }
  .meta a:hover { color: var(--text); border-color: var(--text-dim); }

  footer {
    position: relative; z-index: 1;
    padding: 20px 24px 28px; text-align: center;
    font-size: 11px; color: var(--text-faint); letter-spacing: 0.02em;
  }
  footer .dot { display: inline-block; width: 5px; height: 5px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 6px rgba(74,222,128,0.5); margin-right: 6px; vertical-align: 1px; }
  @media (max-width: 480px) { .card { padding: 28px 22px 22px; } h1 { font-size: 19px; } }
</style>
</head>
<body>
  <div class="grid-bg" aria-hidden="true"></div>
  <div class="accent-orb" aria-hidden="true"></div>
  <main>
    <div class="card">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div class="name">Raft<span class="light">control plane</span></div>
      </div>
      <h1>Sign in</h1>
      <p class="subtitle">Operator access to the per-PR Cloudflare preview environments control plane.</p>
      ${errorMsg ? `<div class="err" role="alert">${errorMsg}</div>` : ''}
      <form method="POST" action="/login" autocomplete="off">
        <div class="field">
          <label for="email">Operator email</label>
          <input id="email" name="email" type="email" required autofocus
                 placeholder="you@your-org.com" value="admin@raft.dev">
        </div>
        <div class="field">
          <label for="key">Session key</label>
          <input id="key" name="key" type="password" required
                 placeholder="SESSION_SIGNING_KEY">
        </div>
        <button type="submit">Continue</button>
      </form>
      <div class="meta">
        Session keys are managed by the deployment operator. The shared key matches the worker's <code>SESSION_SIGNING_KEY</code> secret. Forgot it? <a href="https://github.com/Adi-gitX/Rift#operator-access">Read the docs</a>.
      </div>
    </div>
  </main>
  <footer>
    <span class="dot"></span>raft-control · v0.2.0 · production
  </footer>
</body>
</html>`;

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
