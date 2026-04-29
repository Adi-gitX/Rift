/**
 * Raft Live status — at-a-glance pulse on the entire control plane.
 * Polls /api/health and /api/stats every 5s and keeps a rolling buffer
 * of the last 60 health probes (~5 minutes) rendered as a heat-bar.
 */
import React, { useEffect, useRef, useState } from "react";
import { Activity, RefreshCw, ExternalLink, Cpu, Database, Layers, ListChecks, Server } from "lucide-react";
import { api, fmtRelative } from "@/dashboard/raft/api";
import { HealthHeatbar, MultiLineSparkline, ChartLegend, Donut, Colors } from "@/dashboard/raft/charts";

const HEALTH_HISTORY = 60;

const Pill = ({ status }) => {
  const m = status === "ok"
    ? { color: Colors.ok, label: "ok" }
    : status === "unreachable"
      ? { color: Colors.fail, label: "down" }
      : { color: "#9aa3a8", label: "?" };
  return (
    <span className="inline-flex items-center gap-2 d-mono text-[11.5px] text-white/85">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.color, boxShadow: `0 0 6px ${m.color}88` }} />
      {m.label}
    </span>
  );
};

const ServiceCard = ({ name, role, url, statusOk, history }) => (
  <div className="border border-white/[0.06] rounded p-5">
    <div className="flex items-center justify-between mb-2">
      <div>
        <div className="d-mono text-[14px] text-white">{name}</div>
        <div className="text-[11px] text-white/55 mt-0.5">{role}</div>
      </div>
      <Pill status={statusOk ? "ok" : statusOk === false ? "unreachable" : "?"} />
    </div>
    <div className="text-[10.5px] text-white/45 d-mono mb-3 break-all">{url}</div>
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] text-white/35 mb-1.5 d-mono">last {HEALTH_HISTORY} probes · ~5m</div>
      <HealthHeatbar samples={history} />
    </div>
  </div>
);

const SPARKLINE_LINES = [
  { key: "provisions",        color: Colors.primary, label: "provisions" },
  { key: "teardowns",         color: Colors.ok,      label: "teardowns", dashed: true },
  { key: "provisions_failed", color: Colors.fail,    label: "failures" },
];

const STATE_COLORS = {
  ready:        Colors.ok,
  provisioning: Colors.warn,
  pending:      "#9aa3a8",
  updating:     Colors.warn,
  failed:       Colors.fail,
  tearing_down: "#9aa3a8",
  torn_down:    "rgba(255,255,255,0.30)",
};

export const RaftStatus = () => {
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState({ control: [], dispatcher: [], tail: [] });
  const [tick, setTick] = useState(0);
  const lastUpdate = useRef(null);

  const reload = async () => {
    const [h, s] = await Promise.all([api.health().catch(() => null), api.stats().catch(() => null)]);
    const hd = h?.data ?? null;
    setHealth(hd);
    setStats(s?.data ?? null);
    lastUpdate.current = Date.now();
    setTick((t) => t + 1);
    setHistory((prev) => {
      const push = (arr, st) => {
        const next = [...arr, st === "ok" ? "ok" : st === "unreachable" ? "fail" : "pending"];
        return next.slice(-HEALTH_HISTORY);
      };
      return {
        control:    push(prev.control,    hd?.control?.status ?? "?"),
        dispatcher: push(prev.dispatcher, hd?.dispatcher?.status ?? "?"),
        tail:       push(prev.tail,       hd?.tail?.status ?? "?"),
      };
    });
  };

  useEffect(() => {
    reload();
    const id = setInterval(reload, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = stats?.prEnvironments?.by_state ?? {};
  const stateSlices = Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => ({ label: k, value: v, color: STATE_COLORS[k] ?? "#888" }));
  const totals = stats?.totals ?? {};
  const provs = (totals.provisions_succeeded ?? 0) + (totals.provisions_failed ?? 0);
  const successRate = provs === 0 ? null : Math.round(((totals.provisions_succeeded ?? 0) / provs) * 100);

  const allOk =
    history.control.at(-1) === "ok" &&
    history.dispatcher.at(-1) === "ok" &&
    history.tail.at(-1) === "ok";

  return (
    <div data-testid="raft-status">
      <div className="flex items-end justify-between px-8 pt-10 pb-4 border-b border-white/[0.04]">
        <div>
          <div className="flex items-center gap-3 text-[11.5px] text-white/45 d-mono uppercase tracking-[0.08em] mb-1.5">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: allOk ? Colors.ok : Colors.fail, boxShadow: `0 0 8px ${allOk ? Colors.ok : Colors.fail}aa` }} />
              {allOk ? "all systems operational" : "degraded"}
            </span>
            <span className="text-white/15">·</span>
            <span>polling every 5s</span>
            <span className="text-white/15">·</span>
            <span>tick {tick}</span>
          </div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">Live status</h1>
          <p className="mt-1 text-[13px] text-white/55">Real-time pulse across every Raft Worker, every PR, and the Cloudflare resources backing them.</p>
        </div>
        <button onClick={reload} className="fc-btn-icon" title="Refresh now"><RefreshCw size={14} /></button>
      </div>

      <div className="px-8 py-7 space-y-7">
        {/* Service cards with health timeline */}
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Workers (3)</h2>
          <div className="grid grid-cols-3 gap-3">
            <ServiceCard
              name="raft-control"
              role="webhooks · API · dashboard · DOs · cron"
              url="https://raft-control.adityakammati3.workers.dev"
              statusOk={health?.control?.status === "ok"}
              history={history.control}
            />
            <ServiceCard
              name="raft-dispatcher"
              role="path-based proxy → user worker"
              url={health?.dispatcher?.url ?? "https://raft-dispatcher.adityakammati3.workers.dev"}
              statusOk={health?.dispatcher?.status === "ok"}
              history={history.dispatcher}
            />
            <ServiceCard
              name="raft-tail"
              role="Tail consumer → raft-tail-events queue"
              url={health?.tail?.url ?? "https://raft-tail.adityakammati3.workers.dev"}
              statusOk={health?.tail?.status === "ok"}
              history={history.tail}
            />
          </div>
        </section>

        {/* Activity sparkline + state donut + headline tiles */}
        <section className="grid grid-cols-[2fr_1fr] gap-3">
          <div className="border border-white/[0.06] rounded p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Lifecycle activity · 7d</h2>
              <ChartLegend items={SPARKLINE_LINES} />
            </div>
            {stats ? <MultiLineSparkline data={stats.daily} lines={SPARKLINE_LINES} /> : <div className="h-32" />}
          </div>
          <div className="border border-white/[0.06] rounded p-5">
            <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-2">PR env state distribution</h2>
            <div className="flex items-center gap-3 mt-2">
              <Donut slices={stateSlices} label={stateSlices.reduce((a, s) => a + s.value, 0)} sub="ENVS" />
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
          </div>
        </section>

        {/* Tiles */}
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Headline numbers</h2>
          <div className="grid grid-cols-4 gap-3">
            <Tile icon={<Cpu size={11} />}        label="Workers used"    value={stats?.freeTier?.workers?.used ?? "—"}     sub={`free cap ${stats?.freeTier?.workers?.max ?? 100}`} />
            <Tile icon={<Database size={11} />}   label="D1 dbs used"     value={stats?.freeTier?.d1_databases?.used ?? "—"} sub={`free cap ${stats?.freeTier?.d1_databases?.max ?? 10}`} />
            <Tile icon={<Layers size={11} />}     label="KV namespaces"   value={stats?.freeTier?.kv_namespaces?.used ?? "—"} sub="per-PR + control" />
            <Tile icon={<ListChecks size={11} />} label="Queues used"     value={stats?.freeTier?.queues?.used ?? "—"}        sub={`free cap ${stats?.freeTier?.queues?.max ?? 10}`} />
          </div>
        </section>

        {/* Endpoint links + version */}
        <section className="grid grid-cols-3 gap-3">
          <a href="https://raft-control.adityakammati3.workers.dev/healthz" target="_blank" rel="noreferrer" className="border border-white/[0.06] rounded px-4 py-3 hover:bg-white/[0.02] inline-flex items-center justify-between text-[12px] text-white/75">
            <span><Server size={11} className="inline -mt-0.5 mr-2 text-white/55" />/healthz</span>
            <ExternalLink size={11} />
          </a>
          <a href="https://raft-control.adityakammati3.workers.dev/version" target="_blank" rel="noreferrer" className="border border-white/[0.06] rounded px-4 py-3 hover:bg-white/[0.02] inline-flex items-center justify-between text-[12px] text-white/75">
            <span><Activity size={11} className="inline -mt-0.5 mr-2 text-white/55" />/version</span>
            <ExternalLink size={11} />
          </a>
          <div className="border border-white/[0.06] rounded px-4 py-3 inline-flex items-center justify-between text-[12px] text-white/75">
            <span>success rate</span>
            <span className="d-mono text-[#5BE08F]">{successRate === null ? "—" : `${successRate}%`}</span>
          </div>
        </section>

        <p className="text-[10.5px] text-white/35 d-mono">last update {lastUpdate.current ? fmtRelative(lastUpdate.current / 1000) : "never"} · refresh tick {tick}</p>
      </div>
    </div>
  );
};

const Tile = ({ icon, label, value, sub }) => (
  <div className="border border-white/[0.06] rounded p-4">
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-white/45 d-mono">
      {icon} {label}
    </div>
    <div className="mt-2 d-mono text-[20px] font-semibold text-white">{value}</div>
    {sub && <div className="text-[11px] text-white/45 mt-1">{sub}</div>}
  </div>
);
