/**
 * Raft Settings — operator session, installations, .raft.json template,
 * raft-bundle.yml GitHub Action snippet. Themed to match the RaftShell.
 */
import React, { useEffect, useState } from "react";
import { Copy, Check, ExternalLink, Loader2 } from "lucide-react";
import { api, fmtDate } from "@/dashboard/raft/api";

const RAFT_JSON_TEMPLATE = `{
  "version": 1,
  "worker_path": ".",
  "bundle_command": "wrangler deploy --dry-run --outdir=dist",
  "bindings_to_isolate": ["DB", "KV", "QUEUE", "BUCKET"],
  "do_classes_to_shard": ["ChatRoom", "Counter"],
  "max_d1_export_size_mb": 100,
  "ttl_days": 7
}`;

const GH_ACTION_SNIPPET = `name: raft-bundle
on:
  pull_request:
    types: [opened, synchronize, reopened]
jobs:
  build-and-upload:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx wrangler deploy --dry-run --outdir=dist
      - run: cd dist && zip -r ../bundle.zip .
      - name: Upload to Raft
        env:
          RAFT_UPLOAD_URL: \${{ secrets.RAFT_UPLOAD_URL }}
          RAFT_UPLOAD_TOKEN: \${{ secrets.RAFT_UPLOAD_TOKEN }}
          RAFT_REPO_ID: \${{ secrets.RAFT_REPO_ID }}
        run: |
          curl -sS -X POST "$RAFT_UPLOAD_URL/api/v1/bundles/upload" \\
            -H "Authorization: Bearer $RAFT_UPLOAD_TOKEN" \\
            -H "X-Raft-Repo-Id: $RAFT_REPO_ID" \\
            -H "X-Raft-Head-Sha: \${{ github.event.pull_request.head.sha }}" \\
            --data-binary @bundle.zip --fail-with-body
`;

const CodeBlock = ({ children, label }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="border border-white/[0.06] rounded">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5">
        <span className="d-mono text-[11px] text-white/55">{label}</span>
        <button onClick={onCopy} className="text-white/45 hover:text-white/85 inline-flex items-center gap-1 text-[11px]">
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="text-[11.5px] leading-5 text-white/85 p-4 d-mono overflow-auto bg-black">
{children}
      </pre>
    </div>
  );
};

const FreeTierGauges = ({ stats }) => {
  if (!stats?.freeTier) return null;
  const ft = stats.freeTier;
  const Gauge = ({ label, slot }) => {
    const used = slot?.used ?? 0;
    const max = slot?.max ?? 0;
    const pr = slot?.pr_envs ?? 0;
    const cp = slot?.control_plane ?? 0;
    const pct = Math.min(100, max ? (used / max) * 100 : 0);
    const tone = pct > 80 ? "#FF8A75" : pct > 50 ? "#EAB308" : "#5BE08F";
    return (
      <div className="px-4 py-3 border border-white/[0.06] rounded">
        <div className="flex items-center justify-between text-[11px] d-mono text-white/55">
          <span>{label}</span>
          <span className="text-white/85">{used} <span className="text-white/30">/ {max}</span></span>
        </div>
        <div className="mt-2 h-1 bg-white/[0.06] rounded overflow-hidden">
          <div className="h-1 transition-[width]" style={{ width: `${pct}%`, background: tone }} />
        </div>
        {(pr > 0 || cp > 0) && (
          <div className="mt-1.5 text-[10px] d-mono text-white/40 flex justify-between">
            <span>{pr} PR env{pr === 1 ? "" : "s"}</span>
            <span>+ {cp} control-plane</span>
          </div>
        )}
      </div>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-3">
      <Gauge label="Workers"       slot={ft.workers} />
      <Gauge label="D1 dbs"        slot={ft.d1_databases} />
      <Gauge label="KV namespaces" slot={ft.kv_namespaces} />
      <Gauge label="Queues"        slot={ft.queues} />
    </div>
  );
};

export const RaftSettings = () => {
  const [me, setMe] = useState(null);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.me(), api.stats().catch(() => null)])
      .then(([m, s]) => {
        setMe(m?.data ?? null);
        setStats(s?.data ?? null);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div data-testid="raft-settings">
      <div className="px-8 pt-10 pb-4 border-b border-white/[0.04]">
        <h1 className="text-[24px] font-semibold tracking-tight text-white">Settings</h1>
        <p className="mt-1 text-[13px] text-white/55">Operator session, GitHub installations, and onboarding snippets.</p>
      </div>

      <div className="px-8 py-7 space-y-7 max-w-4xl">
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Session</h2>
          <div className="border border-white/[0.06] rounded px-4 py-4">
            {loading ? (
              <div className="flex items-center gap-2 text-white/55 text-[13px]">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </div>
            ) : me?.email ? (
              <>
                <p className="text-[13px] text-white/85">
                  Signed in as <span className="d-mono text-[#5BE08F]">{me.email}</span>
                </p>
                <p className="mt-1 text-[11.5px] text-white/45">Expires {fmtDate(me.exp)}</p>
              </>
            ) : (
              <p className="text-[13px] text-white/55">No session.</p>
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Installations</h2>
            {me?.githubApp?.installUrl && (
              <a
                href={me.githubApp.installUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-[#ED462D] hover:text-[#ff7a5c] inline-flex items-center gap-1 d-mono"
              >
                + Install on another repo ↗
              </a>
            )}
          </div>
          <div className="border border-white/[0.06] rounded">
            {(me?.installations ?? []).length === 0 ? (
              <div className="px-4 py-5 text-[12.5px] text-white/55">
                No active installations.
                {me?.githubApp?.installUrl && (
                  <a href={me.githubApp.installUrl} target="_blank" rel="noreferrer" className="ml-2 text-[#ED462D] hover:text-[#ff7a5c]">Install Raft →</a>
                )}
              </div>
            ) : (
              (me?.installations ?? []).map((i) => (
                <div key={i.id} className="grid grid-cols-[minmax(0,1fr)_140px_120px] gap-3 px-4 py-3 border-b border-white/[0.04] last:border-b-0 text-[12.5px]">
                  <span className="text-white/85">{i.githubAccount}</span>
                  <span className="text-white/55">{i.accountType}</span>
                  <span className="d-mono text-white/45">plan {i.plan}</span>
                </div>
              ))
            )}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Free-tier usage</h2>
            <span className="text-[10.5px] d-mono text-white/35">$0 per PR · live counts</span>
          </div>
          {stats ? <FreeTierGauges stats={stats} /> : <div className="border border-white/[0.06] rounded p-4 text-[12px] text-white/45 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>}
        </section>

        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">.raft.json template</h2>
          <p className="text-[12px] text-white/55 mb-3">
            Drop this in the root of your repo. Defaults are sane — most projects don't need to touch it.
          </p>
          <CodeBlock label=".raft.json">{RAFT_JSON_TEMPLATE}</CodeBlock>
        </section>

        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">GitHub Action</h2>
          <p className="text-[12px] text-white/55 mb-3">
            On every PR, your CI builds the worker bundle and POSTs it to Raft.
          </p>
          <CodeBlock label=".github/workflows/raft-bundle.yml">{GH_ACTION_SNIPPET}</CodeBlock>
        </section>

        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Live endpoints</h2>
          <div className="grid grid-cols-3 gap-3 text-[12px]">
            <a href="https://raft-control.adityakammati3.workers.dev/healthz" target="_blank" rel="noreferrer" className="border border-white/[0.06] rounded px-3 py-3 hover:bg-white/[0.02] inline-flex items-center justify-between text-white/75">
              raft-control /healthz <ExternalLink size={11} />
            </a>
            <a href="https://raft-control.adityakammati3.workers.dev/version" target="_blank" rel="noreferrer" className="border border-white/[0.06] rounded px-3 py-3 hover:bg-white/[0.02] inline-flex items-center justify-between text-white/75">
              /version <ExternalLink size={11} />
            </a>
            <a href="https://raft-dispatcher.adityakammati3.workers.dev" target="_blank" rel="noreferrer" className="border border-white/[0.06] rounded px-3 py-3 hover:bg-white/[0.02] inline-flex items-center justify-between text-white/75">
              raft-dispatcher <ExternalLink size={11} />
            </a>
          </div>
        </section>
      </div>
    </div>
  );
};
