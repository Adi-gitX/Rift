/**
 * Static-site synthesizer.
 *
 * If a customer's repo at `headSha` has no `wrangler.{jsonc,json,toml}` and
 * an `index.html` at the repo root or under `public/`/`dist/`/`build/`,
 * Raft synthesises a Workers module that serves those files inline. This
 * lets HTML-only repos (the most common "what is my preview going to
 * look like?" case) get a working preview without the customer adding
 * any build pipeline.
 *
 * Limits (Workers Free script size cap is 10 MB compressed; we leave room
 * for the wrapper JS overhead):
 *
 *   - per file: 512 KB  (rejected if larger)
 *   - per site: 2.5 MB  (additional files dropped after this with a warning)
 *   - max file count: 100
 */
import type { RepoTree, RepoTreeEntry } from '../github/contents.ts';
import { getRepoBlob, base64ToBytes } from '../github/contents.ts';

export const STATIC_ROOTS = ['', 'public/', 'dist/', 'build/', 'site/'] as const;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_TOTAL_BYTES = 2.5 * 1024 * 1024;
export const MAX_FILES = 100;

const TEXT_EXT_TO_CT: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm:  'text/html; charset=utf-8',
  css:  'text/css; charset=utf-8',
  js:   'application/javascript; charset=utf-8',
  mjs:  'application/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg:  'image/svg+xml',
  txt:  'text/plain; charset=utf-8',
  xml:  'application/xml; charset=utf-8',
  md:   'text/markdown; charset=utf-8',
};

const BIN_EXT_TO_CT: Record<string, string> = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  ico:  'image/x-icon',
  webp: 'image/webp',
  avif: 'image/avif',
  woff: 'font/woff',
  woff2:'font/woff2',
  ttf:  'font/ttf',
  otf:  'font/otf',
  pdf:  'application/pdf',
  mp4:  'video/mp4',
  mp3:  'audio/mpeg',
  wav:  'audio/wav',
};

const extOf = (path: string): string => {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
};

export interface StaticDetection {
  /** True iff the repo has an index.html under one of STATIC_ROOTS. */
  isStatic: boolean;
  /** The root prefix (e.g. "public/") that maps to "/" in the served site, or "" for repo-root. */
  root: string;
  /** Tree entries that should be inlined (already filtered by extension + root). */
  candidates: RepoTreeEntry[];
}

/**
 * Find the most useful site root in the tree. Preference order:
 *   build/ → dist/ → site/ → public/ → repo-root.
 * Built artefacts beat sources when present (they're what the customer
 * meant to ship). For each candidate root we require an `index.html` and
 * then sweep all whitelisted extensions under that root.
 *
 * Note we deliberately do NOT skip when a `wrangler.{jsonc,json,toml}` is
 * present: the customer-pushed bundle path (PRD §9.4) is not yet wired,
 * so for any repo with HTML, static synth is a strict upgrade over the
 * placeholder. Once Track A lands, this preference can flip.
 */
export const detectStatic = (tree: RepoTree): StaticDetection => {
  // Try built-output roots first; fall back to sources/repo-root.
  const orderedRoots = ['build/', 'dist/', 'site/', 'public/', ''] as const;
  for (const root of orderedRoots) {
    const indexPath = `${root}index.html`;
    if (tree.tree.some((e) => e.type === 'blob' && e.path === indexPath)) {
      const candidates = tree.tree.filter((e) => {
        if (e.type !== 'blob') return false;
        if (root && !e.path.startsWith(root)) return false;
        const ext = extOf(e.path);
        return ext in TEXT_EXT_TO_CT || ext in BIN_EXT_TO_CT;
      });
      return { isStatic: true, root, candidates };
    }
  }
  return { isStatic: false, root: '', candidates: [] };
};

export interface InlinedFile {
  /** Site-relative path, always starts with "/". */
  servedPath: string;
  contentType: string;
  /** Raw bytes (binary) — encoded later as base64 in the synth. */
  bytes?: Uint8Array;
  /** Decoded UTF-8 text — embedded as a JSON string in the synth. */
  text?: string;
}

export interface SynthResult {
  files: InlinedFile[];
  totalBytes: number;
  /** Files we skipped (with reason) — surfaced to the dashboard for transparency. */
  warnings: string[];
}

export const fetchAndInlineFiles = async (
  token: string,
  ownerRepo: string,
  detection: StaticDetection,
): Promise<SynthResult> => {
  const files: InlinedFile[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  // Sort: index.html first, then small assets first so we get the most useful
  // pages in if we hit the cap.
  const entries = [...detection.candidates].sort((a, b) => {
    const aIsIndex = a.path.endsWith('index.html') ? 0 : 1;
    const bIsIndex = b.path.endsWith('index.html') ? 0 : 1;
    if (aIsIndex !== bIsIndex) return aIsIndex - bIsIndex;
    return (a.size ?? 0) - (b.size ?? 0);
  });

  for (const entry of entries) {
    if (files.length >= MAX_FILES) {
      warnings.push(`max ${MAX_FILES} files reached, dropped ${entries.length - files.length} more`);
      break;
    }
    if ((entry.size ?? 0) > MAX_FILE_BYTES) {
      warnings.push(`skipped ${entry.path} (${entry.size}B > ${MAX_FILE_BYTES}B per-file cap)`);
      continue;
    }
    if (totalBytes + (entry.size ?? 0) > MAX_TOTAL_BYTES) {
      warnings.push(`skipped ${entry.path} (would exceed ${MAX_TOTAL_BYTES}B per-site cap)`);
      continue;
    }

    const blob = await getRepoBlob(token, ownerRepo, entry.sha);
    const bytes = base64ToBytes(blob.content);
    totalBytes += bytes.byteLength;

    const ext = extOf(entry.path);
    const servedPath = '/' + entry.path.slice(detection.root.length);
    if (ext in TEXT_EXT_TO_CT) {
      files.push({
        servedPath,
        contentType: TEXT_EXT_TO_CT[ext]!,
        text: new TextDecoder('utf-8').decode(bytes),
      });
    } else {
      files.push({
        servedPath,
        contentType: BIN_EXT_TO_CT[ext]!,
        bytes,
      });
    }
  }

  return { files, totalBytes, warnings };
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let s = '';
  // chunk to avoid blowing the call stack on large arrays
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + CHUNK)));
  }
  return btoa(s);
};

/**
 * Emit a Workers module that serves the inlined files.
 *
 *   GET "/"               → /index.html
 *   GET unknown extensionless paths → /index.html (SPA fallback)
 *   GET unknown asset paths        → 404
 *
 * Cache-Control: no-store keeps reviewers from caching stale preview pages
 * while their PR is being iterated on.
 */
export const synthesizeWorker = (result: SynthResult): string => {
  const filesObj: Record<string, { ct: string; b: string; bin: boolean }> = {};
  for (const f of result.files) {
    if (f.bytes) {
      filesObj[f.servedPath] = { ct: f.contentType, b: bytesToBase64(f.bytes), bin: true };
    } else {
      filesObj[f.servedPath] = { ct: f.contentType, b: f.text ?? '', bin: false };
    }
  }
  const fileMapJson = JSON.stringify(filesObj);
  return `// Synthesized by Raft for static-mode preview.
// Files inlined: ${result.files.length} · total bytes: ${result.totalBytes}
const FILES = ${fileMapJson};
const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
export default {
  async fetch(req) {
    const url = new URL(req.url);
    let p = url.pathname || '/';
    if (p === '/' || p === '') p = '/index.html';
    let f = FILES[p];
    if (!f && !p.includes('.')) f = FILES['/index.html'];
    if (!f) return new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = f.bin ? decode(f.b) : f.b;
    return new Response(body, {
      headers: {
        'content-type': f.ct,
        'cache-control': 'no-store',
        'x-raft-preview': 'static',
      },
    });
  },
};
`;
};
