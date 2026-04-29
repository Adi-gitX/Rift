/**
 * Raft System — live worker health, integrations, cron schedule.
 * Pulls /api/health every 5 seconds.
 */
import React, { useEffect, useRef, useState } from "react";
import { ExternalLink, RefreshCw, Activity, Clock, Server, Database, Layers, ListChecks, Network, Radio } from "lucide-react";
import { api, fmtRelative } from "@/dashboard/raft/api";
import { HealthHeatbar, MultiLineSparkline, ChartLegend, Colors } from "@/dashboard/raft/charts";

const HEALTH_HISTORY = 60;
const SPARKLINE_LINES = [
  { key: "provisions",        color: Colors.primary, label: "provisions" },
  { key: "teardowns",         color: Colors.ok,      label: "teardowns", dashed: true },
  { key: "provisions_failed", color: Colors.fail,    label: "failures" },
];

const StatusPill = ({ status }) => {
  const map = {
    ok:          { color: "#5BE08F", label: "ok" },
    unreachable: { color: "#FF8A75", label: "unreachable" },
    "?":         { color: "#9aa3a8", label: "checking…" },
  };
  const m = map[status] ?? map["?"];
  return (
    <span className="inline-flex items-center gap-2 d-mono text-[11.5px] text-white/85">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: m.color, boxShadow: `0 0 6px ${m.color}88` }} />
      {m.label}
    </span>
  );
};

const WorkerCard = ({ name, role, url, status, httpStatus, version }) => (
  <div className="border border-white/[0.06] rounded p-5">
    <div className="flex items-center justify-between mb-3">
      <div>
        <div className="d-mono text-[14px] text-white">{name}</div>
        <div className="text-[11.5px] text-white/55 mt-0.5">{role}</div>
      </div>
      <StatusPill status={status} />
    </div>
    <div className="text-[11px] text-white/45 d-mono mb-3 break-all">{url}</div>
    <div className="flex items-center gap-3 text-[10.5px] text-white/45 d-mono">
      {httpStatus !== undefined && <span>http {httpStatus}</span>}
      {version && <span>v {version}</span>}
      <a href={url} target="_blank" rel="noreferrer" className="ml-auto text-[#ED462D] hover:text-[#ff7a5c] inline-flex items-center gap-1">
        open <ExternalLink size={11} />
      </a>
    </div>
  </div>
);

const Tile = ({ icon, label, value, sub }) => (
  <div className="border border-white/[0.06] rounded p-4">
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-white/45 d-mono">
      {icon} {label}
    </div>
    <div className="mt-2 d-mono text-[20px] font-semibold text-white">{value}</div>
    {sub && <div className="text-[11px] text-white/45 mt-1">{sub}</div>}
  </div>
);

export const RaftSystem = () => {
  const [health, setHealth] = useState(null);
  const [stats, setStats] = useState(null);
  const [tick, setTick] = useState(0);
  const [history, setHistory] = useState({ control: [], dispatcher: [], tail: [] });

  const reload = async () => {
    const [h, s] = await Promise.all([api.health().catch(() => null), api.stats().catch(() => null)]);
    const hd = h?.data ?? null;
    setHealth(hd);
    setStats(s?.data ?? null);
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

  return (
    <div data-testid="raft-system">
      <div className="flex items-end justify-between px-8 pt-10 pb-4 border-b border-white/[0.04]">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">System</h1>
          <p className="mt-1 text-[13px] text-white/55">
            Live worker health, integrations, cron schedule. Polls every 5s.
          </p>
        </div>
        <button onClick={reload} className="fc-btn-icon" title="Refresh"><RefreshCw size={14} /></button>
      </div>

      <div className="px-8 py-7 space-y-7">
        {/* Workers */}
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Cloudflare Workers (3)</h2>
          <div className="grid grid-cols-3 gap-3">
            <WorkerCard
              name="raft-control"
              role="webhooks · API · dashboard · cron · queue · DOs"
              url="https://raft-control.adityakammati3.workers.dev"
              status={health?.control?.status ?? "?"}
              version={health?.control?.version}
            />
            <WorkerCard
              name="raft-dispatcher"
              role="path-based proxy → user worker"
              url={health?.dispatcher?.url ?? "https://raft-dispatcher.adityakammati3.workers.dev"}
              status={health?.dispatcher?.status ?? "?"}
              httpStatus={health?.dispatcher?.httpStatus}
            />
            <WorkerCard
              name="raft-tail"
              role="tail consumer → raft-tail-events queue"
              url={health?.tail?.url ?? "https://raft-tail.adityakammati3.workers.dev"}
              status={health?.tail?.status ?? "?"}
              httpStatus={health?.tail?.httpStatus}
            />
          </div>
        </section>

        {/* Health timeline + activity sparkline */}
        <section className="grid grid-cols-[1fr_2fr] gap-3">
          <div className="border border-white/[0.06] rounded p-5">
            <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Health timeline · last {HEALTH_HISTORY} probes</h2>
            <div className="space-y-3">
              {[
                { name: "raft-control",    samples: history.control },
                { name: "raft-dispatcher", samples: history.dispatcher },
                { name: "raft-tail",       samples: history.tail },
              ].map((row) => (
                <div key={row.name}>
                  <div className="text-[10.5px] d-mono text-white/55 mb-1">{row.name}</div>
                  <HealthHeatbar samples={row.samples} />
                </div>
              ))}
            </div>
            <p className="mt-3 text-[10px] text-white/35 d-mono">poll every 5s · ~5min visible</p>
          </div>
          <div className="border border-white/[0.06] rounded p-5">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Lifecycle activity · 7d</h2>
              <ChartLegend items={SPARKLINE_LINES} />
            </div>
            {stats ? <MultiLineSparkline data={stats.daily} lines={SPARKLINE_LINES} /> : <div className="h-32" />}
          </div>
        </section>

        {/* Resource counts (live from /api/stats) */}
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Provisioned resources (live)</h2>
          <div className="grid grid-cols-4 gap-3">
            <Tile icon={<Database size={11} />} label="D1 dbs"     value={stats?.freeTier?.d1_databases?.used ?? "—"} sub={`free cap ${stats?.freeTier?.d1_databases?.max ?? 10}`} />
            <Tile icon={<Layers size={11} />}   label="KV namespaces" value={stats?.freeTier?.kv_namespaces?.used ?? "—"} sub="per-PR + control" />
            <Tile icon={<ListChecks size={11} />} label="Queues" value={stats?.freeTier?.queues?.used ?? "—"} sub={`free cap ${stats?.freeTier?.queues?.max ?? 10}`} />
            <Tile icon={<Server size={11} />}    label="Workers" value={stats?.freeTier?.workers?.used ?? "—"} sub={`free cap ${stats?.freeTier?.workers?.max ?? 100}`} />
          </div>
        </section>

        {/* Cron */}
        <section className="grid grid-cols-2 gap-3">
          <div className="border border-white/[0.06] rounded p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-white/45 d-mono">
              <Clock size={12} /> Cron · stale-env GC
            </div>
            <div className="mt-3 d-mono text-[16px] text-white">{health?.cron?.schedule ?? "0 4 * * *"}</div>
            <div className="text-[11.5px] text-white/55 mt-1">
              Sweeps PR envs whose <code className="d-mono text-white/85">last_activity_at</code> is older than 7 days. Triggers TeardownRunner with <code className="d-mono text-white/85">reason=idle_7d</code>.
            </div>
          </div>
          <div className="border border-white/[0.06] rounded p-5">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-white/45 d-mono">
              <Activity size={12} /> Queues
            </div>
            <div className="mt-3 d-mono text-[14px] text-white space-y-1">
              <div><span className="text-white/45">events:</span> raft-events <span className="text-white/35">+ DLQ</span></div>
              <div><span className="text-white/45">tail:</span> raft-tail-events</div>
            </div>
            <div className="text-[10.5px] text-white/45 mt-2 d-mono">max_batch_size: 10 · max_retries: 5 · backoff: 1/2/4/8/16s</div>
          </div>
        </section>

        {/* Integrations */}
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Integrations &amp; durable objects</h2>
          <div className="grid grid-cols-5 gap-3">
            {[
              { Icon: Server,  label: "Workers (free)" },
              { Icon: Database,label: "D1 (free)" },
              { Icon: Layers,  label: "KV (free)" },
              { Icon: ListChecks, label: "Queues (free)" },
              { Icon: Network, label: "DOs · 5 classes" },
              { Icon: Radio,   label: "Tail (no TC)" },
              { Icon: Activity,label: "Workers Logs" },
              { Icon: Clock,   label: "Cron Triggers" },
            ].map((it) => (
              <div key={it.label} className="border border-white/[0.06] rounded px-3 py-4 flex flex-col items-center gap-1.5">
                <it.Icon className="h-4 w-4 text-white/85" />
                <span className="text-[10.5px] text-white/55 d-mono">{it.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* DO classes inventory */}
        <section>
          <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Durable Object classes</h2>
          <div className="border border-white/[0.06] rounded">
            {[
              { name: "RepoCoordinator",  desc: "One per (installation, repo). State machine + dispatch into ProvisionRunner." },
              { name: "PrEnvironment",    desc: "One per PR. Single-writer for state transitions. Holds log buffer." },
              { name: "ProvisionRunner",  desc: "Alarm-driven 5-step machine. Idempotent on replay. Backoff 1/2/4/8/16s." },
              { name: "TeardownRunner",   desc: "Alarm-driven 9-step destruction machine. Idempotent. CF 404 = already gone." },
              { name: "LogTail",          desc: "Hibernatable WebSocket fan-out + ring buffer for live logs." },
            ].map((d) => (
              <div key={d.name} className="grid grid-cols-[200px_minmax(0,1fr)] gap-4 px-4 py-3 border-b border-white/[0.04] last:border-b-0">
                <span className="d-mono text-[12.5px] text-white">{d.name}</span>
                <span className="text-[12px] text-white/65">{d.desc}</span>
              </div>
            ))}
          </div>
        </section>

        <p className="text-[10.5px] text-white/35 d-mono">refresh tick: {tick} · poll 5s · health probes are best-effort fetch()</p>
      </div>
    </div>
  );
};
