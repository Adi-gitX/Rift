/**
 * Unit tests for the static-site synthesizer.
 *
 *  - detectStatic: skips repos with a wrangler config; finds index.html
 *    under each supported root prefix.
 *  - synthesizeWorker: emits a runnable Workers module that serves the
 *    inlined files and falls through to index.html for SPA routes.
 */
import { describe, expect, it } from 'vitest';
import {
  detectStatic,
  synthesizeWorker,
  STATIC_ROOTS,
  type SynthResult,
} from '../../../../src/lib/static-site/synth.ts';
import type { RepoTree } from '../../../../src/lib/github/contents.ts';

const tree = (paths: { path: string; size?: number }[]): RepoTree => ({
  sha: 'abc',
  truncated: false,
  tree: paths.map((p) => ({
    path: p.path,
    mode: '100644',
    type: 'blob',
    sha: `sha-${p.path}`,
    size: p.size ?? 0,
  })),
});

describe('detectStatic', () => {
  it('detects static even when wrangler config is present (Track A is not wired yet)', () => {
    const t = tree([{ path: 'wrangler.jsonc' }, { path: 'public/index.html' }, { path: 'src/index.ts' }]);
    const d = detectStatic(t);
    expect(d.isStatic).toBe(true);
    expect(d.root).toBe('public/');
  });

  it('detects a repo-root index.html when no built-output dir exists', () => {
    const t = tree([{ path: 'index.html' }, { path: 'style.css' }]);
    const d = detectStatic(t);
    expect(d.isStatic).toBe(true);
    expect(d.root).toBe('');
    expect(d.candidates.map((c) => c.path).sort()).toEqual(['index.html', 'style.css']);
  });

  it('detects public/index.html and only inlines files under public/', () => {
    const t = tree([
      { path: 'README.md' },
      { path: 'package.json' },
      { path: 'public/index.html' },
      { path: 'public/app.css' },
      { path: 'public/img/logo.png' },
      { path: 'src/main.ts' },
    ]);
    const d = detectStatic(t);
    expect(d.isStatic).toBe(true);
    expect(d.root).toBe('public/');
    expect(d.candidates.map((c) => c.path).sort()).toEqual([
      'public/app.css',
      'public/img/logo.png',
      'public/index.html',
    ]);
  });

  it('prefers build/ over dist/, dist/ over public/, public/ over repo-root', () => {
    // Both build/ and public/ contain index.html — build/ wins.
    let t = tree([{ path: 'public/index.html' }, { path: 'build/index.html' }]);
    expect(detectStatic(t).root).toBe('build/');

    // Both dist/ and public/ — dist/ wins.
    t = tree([{ path: 'public/index.html' }, { path: 'dist/index.html' }]);
    expect(detectStatic(t).root).toBe('dist/');

    // Both public/ and repo-root — public/ wins.
    t = tree([{ path: 'index.html' }, { path: 'public/index.html' }]);
    expect(detectStatic(t).root).toBe('public/');
  });

  it('finds index.html under each supported root in isolation', () => {
    for (const root of STATIC_ROOTS) {
      const t = tree([{ path: `${root}index.html` }]);
      const d = detectStatic(t);
      expect(d.isStatic).toBe(true);
      expect(d.root).toBe(root);
    }
  });

  it('returns isStatic=false when no index.html exists anywhere', () => {
    const t = tree([{ path: 'src/main.ts' }, { path: 'README.md' }]);
    expect(detectStatic(t).isStatic).toBe(false);
  });

  it('drops blob entries with unknown extensions', () => {
    const t = tree([
      { path: 'index.html' },
      { path: 'data.parquet' },
      { path: 'binary.dmg' },
      { path: 'style.css' },
    ]);
    const d = detectStatic(t);
    expect(d.candidates.map((c) => c.path).sort()).toEqual(['index.html', 'style.css']);
  });
});

describe('synthesizeWorker', () => {
  const sample: SynthResult = {
    files: [
      { servedPath: '/index.html', contentType: 'text/html; charset=utf-8', text: '<h1>hi</h1>' },
      { servedPath: '/style.css', contentType: 'text/css; charset=utf-8', text: 'body{color:red}' },
      { servedPath: '/logo.png', contentType: 'image/png', bytes: new Uint8Array([0xff, 0x00, 0x88]) },
    ],
    totalBytes: 30,
    warnings: [],
  };

  it('emits a module that GET / returns the index html', async () => {
    const source = synthesizeWorker(sample);
    const mod = await loadModule(source);
    const res = await mod.fetch(new Request('https://x/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toBe('<h1>hi</h1>');
  });

  it('serves a CSS file with the right content-type', async () => {
    const mod = await loadModule(synthesizeWorker(sample));
    const res = await mod.fetch(new Request('https://x/style.css'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8');
    expect(await res.text()).toBe('body{color:red}');
  });

  it('serves a binary file by base64-decoding back to bytes', async () => {
    const mod = await loadModule(synthesizeWorker(sample));
    const res = await mod.fetch(new Request('https://x/logo.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes]).toEqual([0xff, 0x00, 0x88]);
  });

  it('falls back to index.html for an unknown extensionless path (SPA route)', async () => {
    const mod = await loadModule(synthesizeWorker(sample));
    const res = await mod.fetch(new Request('https://x/about'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>hi</h1>');
  });

  it('returns 404 for an unknown asset path with an extension', async () => {
    const mod = await loadModule(synthesizeWorker(sample));
    const res = await mod.fetch(new Request('https://x/missing.png'));
    expect(res.status).toBe(404);
  });

  it('escapes embedded quotes / backslashes safely (no JS injection)', async () => {
    const tricky: SynthResult = {
      files: [
        {
          servedPath: '/index.html',
          contentType: 'text/html; charset=utf-8',
          text: 'A"B</script><script>alert(1)</script>C\\D',
        },
      ],
      totalBytes: 0,
      warnings: [],
    };
    const mod = await loadModule(synthesizeWorker(tricky));
    const res = await mod.fetch(new Request('https://x/'));
    expect(await res.text()).toBe('A"B</script><script>alert(1)</script>C\\D');
  });
});

// Evaluate the synthesised module source. The source uses `export default
// {...}` which we rewrite to `return {...}` so we can run it in a Function
// body without needing vite-node's data: URL import support.
const loadModule = async (source: string): Promise<{ fetch: (req: Request) => Promise<Response> }> => {
  const body = source.replace(/export default /, 'return ');
  const factory = new Function(body) as () => { fetch: (req: Request) => Promise<Response> };
  return factory();
};
