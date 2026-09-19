/**
 * In-memory fake of the GitHub REST endpoints Raft calls, for integration
 * tests. Seed a repo's file tree over HTTP from inside a test:
 *
 *   POST https://fake-gh.local/seed { repo: 'acme/api', files: { 'wrangler.jsonc': '...' } }
 *
 * Then any `GET /repos/acme/api/git/trees/<sha>?recursive=1` returns that
 * tree, `GET /repos/acme/api/git/blobs/<sha>` returns the blob, and issue
 * comment endpoints record + echo comments.
 */

interface RepoFixture {
  files: Map<string, string>; // path → utf-8 content
}

const repos = new Map<string, RepoFixture>();
const comments = new Map<string, { id: number; body: string }[]>(); // "repo#issue" → comments
let nextCommentId = 4242;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = ((h ^ s.charCodeAt(i)) * 0x01000193) >>> 0;
  return `blob${h.toString(16).padStart(8, '0')}`;
};

const toB64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

export const resetFakeGithub = (): void => {
  repos.clear();
  comments.clear();
};

export const handleFakeGithub = async (request: Request): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.hostname === 'fake-gh.local') {
    if (url.pathname === '/seed' && request.method === 'POST') {
      const body = (await request.json()) as { repo: string; files: Record<string, string> };
      repos.set(body.repo, { files: new Map(Object.entries(body.files)) });
      return json({ ok: true });
    }
    if (url.pathname === '/comments') {
      const key = url.searchParams.get('key') ?? '';
      return json(comments.get(key) ?? []);
    }
    return json({ error: 'unknown fake-gh route' }, 404);
  }
  if (url.hostname !== 'api.github.com') return null;
  let m: RegExpExecArray | null;
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/trees\/[^/]+$/.exec(url.pathname))) {
    const repo = repos.get(m[1] ?? '');
    if (!repo) return json({ message: 'Not Found' }, 404);
    const tree = [...repo.files].map(([path, content]) => ({
      path,
      mode: '100644',
      type: 'blob',
      sha: fnv(`${m?.[1]}:${path}:${content}`),
      size: content.length,
    }));
    return json({ sha: 'tree', tree, truncated: false });
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/git\/blobs\/([^/]+)$/.exec(url.pathname))) {
    const repo = repos.get(m[1] ?? '');
    if (!repo) return json({ message: 'Not Found' }, 404);
    for (const [path, content] of repo.files) {
      if (fnv(`${m[1]}:${path}:${content}`) === m[2]) {
        return json({
          sha: m[2],
          size: content.length,
          content: toB64(content),
          encoding: 'base64',
        });
      }
    }
    return json({ message: 'Not Found' }, 404);
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
    const key = `${m[1]}#${m[2]}`;
    const list = comments.get(key) ?? [];
    if (request.method === 'GET') return json(list);
    const body = (await request.json()) as { body: string };
    const c = { id: nextCommentId++, body: body.body };
    comments.set(key, [...list, c]);
    return json(c, 201);
  }
  if ((m = /^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/.exec(url.pathname))) {
    const id = Number(m[2]);
    const body = (await request.json()) as { body: string };
    for (const list of comments.values()) {
      const hit = list.find((c) => c.id === id);
      if (hit) {
        hit.body = body.body;
        return json(hit);
      }
    }
    return json({ message: 'Not Found' }, 404);
  }
  return json({ message: `fake-github: unmocked ${request.method} ${url.pathname}` }, 599);
};
