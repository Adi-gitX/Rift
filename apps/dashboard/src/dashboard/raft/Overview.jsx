/**
 * Raft Overview — pulls /api/me, /api/stats, /api/pr-environments. Shows
 * live counters, a 7-day activity sparkline, free-tier gauges, recent PRs,
 * and the integrated Cloudflare products grid.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight, Loader2, AlertTriangle, ExternalLink,
  CheckCircle2, AlertCircle, Activity, Clock,
} from "lucide-react";
import { ENDPOINTS, INTEGRATIONS } from "@/dashboard/nav";
import { api, fmtRelative, stateTone } from "@/dashboard/raft/api";
import { Donut, MultiLineSparkline, ChartLegend, StackedBar, Colors } from "@/dashboard/raft/charts";

const Hero = ({ email, deployVersion }) => (
  <section className="px-10 pt-10 pb-7" data-testid="overview-hero">
    <div className="flex items-center gap-3 text-[11.5px] text-white/45 d-mono uppercase tracking-[0.08em] mb-2">
      <span>raft control plane</span>
      <span className="text-white/15">·</span>
      <span>v {deployVersion}</span>
      <span className="text-white/15">·</span>
      <span className="inline-flex items-center gap-1.5"><span className="d-live-dot green inline-block h-1.5 w-1.5 rounded-full" /> production</span>
    </div>
    <h1 className="text-[26px] font-semibold leading-[1.15] tracking-tight text-white">
      Welcome back{email ? `, ${email.split("@")[0]}` : ""}.
    </h1>
    <p className="mt-1.5 text-[14px] text-[#9a9a9a]">
      Live state of every per-PR environment, end to end on Cloudflare's free tier.
    </p>
  </section>
);

const DotGrid = () => (
  <div className="fc-dot-grid" aria-hidden>
    {Array.from({ length: 9 }).map((_, i) => <span key={i} />)}
  </div>
);

const StatCardRow = ({ stats, navigate }) => {
  const counts = stats?.prEnvironments?.by_state ?? {};
  const map = {
    ready:     counts.ready ?? 0,
    inflight:  (counts.pending ?? 0) + (counts.provisioning ?? 0) + (counts.updating ?? 0),
    failed:    counts.failed ?? 0,
    tornDown:  counts.torn_down ?? 0,
  };
  return (
    <section data-testid="endpoint-grid">
      <div className="fc-endpoints">
        {ENDPOINTS.map((ep) => {
          const value = map[ep.key] ?? 0;
          // Pass the tab via query param so the list lands pre-filtered
          // on the same bucket the operator clicked.
          return (
            <button
              key={ep.key}
              onClick={() => navigate(`/dashboard/pr-envs?tab=${ep.key}`)}
              className="fc-endpoint-cell text-left transition-colors hover:bg-white/[0.015]"
              data-testid={`endpoint-${ep.key}`}
            >
              <DotGrid />
              <div className="mt-7 flex items-center gap-2">
                <h3 className="text-[16px] font-semibold text-white">{ep.title}</h3>
                {ep.badge && value > 0 && <span className="fc-pill">{ep.badge}</span>}
              </div>
              <p className="mt-2 text-[13px] leading-[1.55] text-[#9a9a9a]">{ep.desc}</p>
              <div className="mt-5 flex items-baseline gap-2">
                <span className="d-mono text-[28px] font-semibold text-white">{value}</span>
                <span className="text-[11px] text-[#6e6e6e]">PR envs</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
};

const SPARKLINE_LINES = [
  { key: "provisions",        color: Colors.primary, label: "provisions" },
  { key: "teardowns",         color: Colors.ok,      label: "teardowns", dashed: true },
  { key: "provisions_failed", color: Colors.fail,    label: "failures" },
];

const RatesPanel = ({ stats }) => {
  const t = stats?.totals ?? {};
  const provs = (t.provisions_succeeded ?? 0) + (t.provisions_failed ?? 0);
  const successRate = provs === 0 ? null : Math.round(((t.provisions_succeeded ?? 0) / provs) * 100);
  return (
    <div className="grid grid-cols-3 gap-4 px-10">
      <div className="border border-white/[0.06] rounded p-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-white/45 d-mono">
          <CheckCircle2 size={12} /> Success rate
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="d-mono text-[28px] font-semibold text-white">{successRate === null ? "—" : `${successRate}%`}</span>
          <span className="text-[11.5px] text-white/45">{t.provisions_succeeded ?? 0} / {provs} provisions</span>
        </div>
      </div>
      <div className="border border-white/[0.06] rounded p-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-white/45 d-mono">
          <Activity size={12} /> Total provisions
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="d-mono text-[28px] font-semibold text-white">{t.provisions_succeeded ?? 0}</span>
          <span className="text-[11.5px] text-[#FF8A75]">{t.provisions_failed ? `+${t.provisions_failed} failed` : ""}</span>
        </div>
      </div>
      <div className="border border-white/[0.06] rounded p-4">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.1em] text-white/45 d-mono">
          <Clock size={12} /> Total teardowns
        </div>
        <div className="mt-3 flex items-baseline gap-2">
          <span className="d-mono text-[28px] font-semibold text-white">{t.teardowns_succeeded ?? 0}</span>
          <span className="text-[11.5px] text-white/45">cleanly destroyed</span>
        </div>
      </div>
    </div>
  );
};

const FreeTierGauges = ({ stats }) => {
  const ft = stats?.freeTier ?? {};
  const Gauge = ({ label, slot }) => {
    const used = slot?.used ?? 0;
    const max = slot?.max ?? 0;
    const pr = slot?.pr_envs ?? 0;
    const cp = slot?.control_plane ?? 0;
    const pct = Math.min(100, max ? (used / max) * 100 : 0);
    const tone = pct > 80 ? "#FF8A75" : pct > 50 ? "#EAB308" : "#5BE08F";
    const tip = `${pr} PR env${pr === 1 ? "" : "s"} + ${cp} control-plane`;
    return (
      <div className="px-3 py-2 border border-white/[0.06] rounded" title={tip}>
        <div className="flex items-center justify-between text-[10.5px] d-mono text-white/55">
          <span>{label}</span>
          <span className="text-white/85">{used} <span className="text-white/30">/ {max}</span></span>
        </div>
        <div className="mt-1.5 h-1 bg-white/[0.06] rounded overflow-hidden">
          <div className="h-1 transition-[width]" style={{ width: `${pct}%`, background: tone }} />
        </div>
      </div>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <Gauge label="Workers" slot={ft.workers} />
      <Gauge label="D1 dbs"  slot={ft.d1_databases} />
      <Gauge label="KV ns"   slot={ft.kv_namespaces} />
      <Gauge label="Queues"  slot={ft.queues} />
    </div>
  );
};

const STATE_COLORS = {
  ready:        "#5BE08F",
  provisioning: "#EAB308",
  pending:      "#9aa3a8",
  updating:     "#EAB308",
  failed:       "#FF8A75",
  tearing_down: "#9aa3a8",
  torn_down:    "rgba(255,255,255,0.30)",
};

const StateDonut = ({ stats }) => {
  const counts = stats?.prEnvironments?.by_state ?? {};
  const slices = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => ({ label: k, value: v, color: STATE_COLORS[k] ?? "#888" }));
  const total = slices.reduce((a, s) => a + s.value, 0);
  return (
    <div className="flex items-center gap-3 mt-1">
      <Donut slices={slices} label={total} sub="PR ENVS" />
      <div className="flex-1 space-y-1.5">
        {Object.entries(counts).map(([k, v]) => (
          <div key={k} className="flex items-center justify-between text-[10.5px] d-mono">
            <span className="inline-flex items-center gap-1.5 text-white/60">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_COLORS[k] ?? "#888" }} />
              {k}
            </span>
            <span className="text-white/85">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const StatusBadge = ({ status, tone }) => {
  const dotMap = {
    progress: <span className="d-live-dot amber" />,
    triage:   <span className="h-1.5 w-1.5 rounded-full bg-white/55" />,
    done:     <span className="h-1.5 w-1.5 rounded-full bg-[#5BE08F]" />,
    high:     <span className="d-live-dot" />,
  };
  const textMap = {
    progress: "text-[#EAB308]",
    triage:   "text-white/65",
    done:     "text-[#5BE08F]",
    high:     "text-[#FF8A75]",
  };
  return (
    <span className={"inline-flex items-center gap-2 text-[12px] font-medium " + (textMap[tone] || "text-white/65")}>
      {dotMap[tone] || null}
      {status}
    </span>
  );
};

const RecentRows = ({ prs, navigate }) => (
  <section className="mt-12 px-10">
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-[15px] font-semibold tracking-tight text-white">Recent activity</h2>
      <button onClick={() => navigate("/dashboard/pr-envs")} className="fc-inline-link text-[12px] flex items-center gap-1">
        See all <ArrowRight size={12} />
      </button>
    </div>
    {prs.length === 0 ? (
      <div className="border border-dashed border-white/[0.06] rounded p-10 text-center">
        <p className="text-[13px] text-[#9a9a9a]">
          No PR environments yet. Open a PR on a connected repo to begin.
        </p>
      </div>
    ) : (
      <div className="border-t border-b border-white/[0.06] divide-y divide-white/[0.04]">
        {prs.slice(0, 8).map((pr) => (
          <button
            key={pr.id}
            onClick={() => navigate(`/dashboard/pr/${encodeURIComponent(pr.id)}`)}
            className="grid w-full grid-cols-[16px_minmax(0,1fr)_180px_120px_100px_14px] items-center gap-4 px-2 py-3.5 text-left hover:bg-white/[0.02] transition-colors"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#ED462D] shadow-[0_0_6px_rgba(237,70,45,0.55)]" />
            <span className="text-[13.5px] font-medium text-white truncate">
              {pr.repoId}<span className="text-white/35">#</span>{pr.prNumber}
            </span>
            <StatusBadge status={pr.state} tone={stateTone(pr.state)} />
            <span className="d-mono text-[12px] text-white/50">{pr.headSha?.slice(0, 7) ?? "—"}</span>
            <span className="text-[12px] text-white/45 text-right">{fmtRelative(pr.lastActivityAt)}</span>
            <ArrowRight size={12} className="text-white/30" />
          </button>
        ))}
      </div>
    )}
  </section>
);

const IntegrationsBlock = () => (
  <section className="mt-14 px-10 pb-10">
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-[15px] font-semibold tracking-tight text-white">Integrated Cloudflare products</h2>
      <a href="https://github.com/Adi-gitX/Rift#why-each-cloudflare-product-is-here" target="_blank" rel="noreferrer" className="fc-inline-link text-[12px] flex items-center gap-1">
        Why each <ExternalLink size={12} />
      </a>
    </div>
    <div className="grid grid-cols-6 border border-white/[0.06] rounded">
      {INTEGRATIONS.map((it, i) => {
        const Logo = it.Logo;
        return (
          <div
            key={it.name}
            className={"flex flex-col items-center justify-center gap-2 py-7 " + (i % 6 !== 5 ? "border-r border-white/[0.06]" : "")}
          >
            <Logo className="h-6 w-6 text-white/85" />
            <span className="text-[11.5px] text-white/60">{it.name}</span>
          </div>
        );
      })}
    </div>
  </section>
);

export const RaftOverview = () => {
  const navigate = useNavigate();
  const [me, setMe] = useState(null);
  const [stats, setStats] = useState(null);
  const [prs, setPrs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.me(), api.stats(), api.prEnvironments()])
      .then(([mRes, sRes, pRes]) => {
        setMe(mRes?.data ?? null);
        setStats(sRes?.data ?? null);
        setPrs(pRes?.data?.prs ?? []);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const recent = useMemo(
    () => [...prs].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
    [prs],
  );

  return (
    <div data-testid="raft-overview">
      <Hero email={me?.email} deployVersion={"0.2.0"} />
      <div className="px-10">
        <StatCardRow stats={stats} navigate={navigate} />
      </div>

      {/* Rates */}
      <div className="mt-10">
        <RatesPanel stats={stats} />
      </div>

      {/* Sparkline + state distribution donut + free-tier gauges */}
      <section className="mt-10 px-10">
        <div className="grid grid-cols-[2fr_1fr_1fr] gap-5">
          <div className="border border-white/[0.06] rounded p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-white/65">Last 7 days</h2>
              <ChartLegend items={SPARKLINE_LINES} />
            </div>
            {stats ? (
              <MultiLineSparkline data={stats.daily} lines={SPARKLINE_LINES} />
            ) : (
              <div className="h-32 flex items-center justify-center text-white/40 text-[12px]"><Loader2 size={14} className="animate-spin mr-2" /> loading…</div>
            )}
          </div>
          <div className="border border-white/[0.06] rounded p-5">
            <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-white/65 mb-2">State distribution</h2>
            <StateDonut stats={stats} />
          </div>
          <div className="border border-white/[0.06] rounded p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.08em] text-white/65">Free tier</h2>
              <span className="text-[10.5px] text-white/35 d-mono uppercase tracking-[0.08em]">$0 / PR</span>
            </div>
            {stats ? <FreeTierGauges stats={stats} /> : <div className="h-24 flex items-center justify-center text-white/40 text-[12px]"><Loader2 size={14} className="animate-spin mr-2" /> loading…</div>}
          </div>
        </div>
      </section>

      {loading && (
        <div className="mt-12 px-10 flex items-center gap-2 text-white/55 text-[13px]">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}
      {err && (
        <div className="mt-12 mx-10 flex items-center gap-2 text-rose-400 text-[13px] border border-rose-900 rounded p-3">
          <AlertCircle size={14} /> {err}
        </div>
      )}
      {!loading && !err && <RecentRows prs={recent} navigate={navigate} />}
      <IntegrationsBlock />
    </div>
  );
};
