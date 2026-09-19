/**
 * Sticky PR comment body. Edited in place on every redeploy via the
 * embedded HTML marker (see lib/github/comments.ts).
 */
import type { StepContext } from './context.ts';
import { buildDatabaseSection } from './comment-database.ts';
import type { AwaitBundleResult, LoadConfigResult } from './types.ts';

export interface LiveProbe {
  status: number;
  ms: number;
  bytes: number;
  ok: boolean;
}

const bundleLine = (config: LoadConfigResult, awaited: AwaitBundleResult | undefined): string => {
  if (config.mode === 'customer-bundle') {
    const sizeKb = awaited?.bundleBytes ? (awaited.bundleBytes / 1024).toFixed(1) : '?';
    return `**Bundle:** customer Worker (uploaded via GitHub Action) · ${sizeKb} KB`;
  }
  if (config.mode === 'static' && config.staticSynth) {
    const n = config.staticSynth.fileCount;
    return `**Bundle:** static site · ${n} file${n === 1 ? '' : 's'} · ${(config.staticSynth.totalBytes / 1024).toFixed(1)} KB`;
  }
  return `**Configuration needed.** No \`wrangler.{jsonc,json,toml}\` (with the Raft GitHub Action) and no \`index.html\` found in this repo. Add one to deploy your real code on the next push.`;
};

export const buildPreviewCommentBody = (
  ctx: StepContext,
  config: LoadConfigResult,
  probe: LiveProbe | null,
): string => {
  const dashUrl = `https://raft-control.${ctx.env.CF_WORKERS_SUBDOMAIN}/dashboard/pr/${encodeURIComponent(ctx.prEnvId)}`;
  const awaited = ctx.prior['await-bundle'] as AwaitBundleResult | undefined;
  const lines = [
    `### Raft preview`,
    ``,
    `**Preview:** ${ctx.previewHostname}/`,
    ``,
    bundleLine(config, awaited),
    `**Scope:** \`${ctx.scope}\` · **Worker:** \`${ctx.scriptName}\``,
  ];
  if (probe) {
    lines.push(
      `**Probe:** ${probe.ok ? 'OK' : 'DOWN'} · HTTP ${probe.status} · ${probe.ms} ms · ${(probe.bytes / 1024).toFixed(1)} KB`,
    );
  }
  const db = buildDatabaseSection(ctx.prior);
  if (db.length > 0) lines.push('', ...db);
  lines.push(
    ``,
    `[Open in dashboard](${dashUrl})`,
    ``,
    `<sub>Per-PR isolated Cloudflare environment (Worker · D1 fork · KV · Queue) provisioned by [Raft](https://github.com/Adi-gitX/Rift). Torn down automatically when the PR closes.</sub>`,
  );
  return lines.join('\n');
};
