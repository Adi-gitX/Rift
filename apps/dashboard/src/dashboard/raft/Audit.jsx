/**
 * Raft Audit log — filterable append-only event stream.
 * Filters: action substring, actor substring, time range (24h / 7d / all).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Loader2, AlertTriangle, RefreshCw, Search, Filter } from "lucide-react";
import { api, fmtDate } from "@/dashboard/raft/api";

const ACTION_COLOR = {
  "pr_env.received":     "#5BE08F",
  "pr_env.provisioning": "#EAB308",
  "pr_env.ready":        "#5BE08F",
  "pr_env.failed":       "#FF8A75",
  "pr_env.tearing_down": "#9aa3a8",
  "pr_env.torn_down":    "#9aa3a8",
  "provision.succeeded": "#5BE08F",
  "provision.failed":    "#FF8A75",
  "teardown.succeeded":  "#9aa3a8",
  "teardown.failed":     "#FF8A75",
};

const RANGES = {
  "1h":  3600,
  "24h": 86400,
  "7d":  86400 * 7,
  all:   Number.MAX_SAFE_INTEGER,
};

export const RaftAudit = () => {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [actionQ, setActionQ] = useState("");
  const [actorQ, setActorQ]   = useState("");
  const [range, setRange]     = useState("24h");

  const reload = async () => {
    setLoading(true);
    try {
      const r = await api.audit();
      setEntries(r?.data?.entries ?? []);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);

  const filtered = useMemo(() => {
    const cutoff = Math.floor(Date.now() / 1000) - RANGES[range];
    const aQ = actionQ.toLowerCase().trim();
    const oQ = actorQ.toLowerCase().trim();
    return entries.filter((e) => {
      if ((e.createdAt ?? 0) < cutoff) return false;
      if (aQ && !(e.action ?? "").toLowerCase().includes(aQ)) return false;
      if (oQ && !(e.actor  ?? "").toLowerCase().includes(oQ)) return false;
      return true;
    });
  }, [entries, actionQ, actorQ, range]);

  return (
    <div data-testid="raft-audit">
      <div className="flex items-end justify-between px-8 pt-10 pb-4 border-b border-white/[0.04]">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">Audit log</h1>
          <p className="mt-1 text-[13px] text-white/55">Append-only event stream across every active installation.</p>
        </div>
        <button onClick={reload} className="fc-btn-icon" title="Refresh"><RefreshCw size={14} /></button>
      </div>

      {/* Filter bar */}
      <div className="px-8 py-4 border-b border-white/[0.04] flex items-center gap-3 flex-wrap">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            value={actionQ}
            onChange={(e) => setActionQ(e.target.value)}
            placeholder="action (e.g. provision.)"
            className="bg-white/[0.04] border border-white/[0.06] rounded h-8 pl-8 pr-2 text-[12.5px] text-white/85 placeholder-white/30 outline-none focus:border-white/20 w-56"
            data-testid="audit-action-filter"
          />
        </div>
        <div className="relative">
          <Filter size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
          <input
            value={actorQ}
            onChange={(e) => setActorQ(e.target.value)}
            placeholder="actor"
            className="bg-white/[0.04] border border-white/[0.06] rounded h-8 pl-8 pr-2 text-[12.5px] text-white/85 placeholder-white/30 outline-none focus:border-white/20 w-44"
            data-testid="audit-actor-filter"
          />
        </div>
        <div className="flex items-center gap-1 border border-white/[0.06] rounded p-0.5 ml-auto">
          {["1h", "24h", "7d", "all"].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={
                "h-7 px-3 text-[11.5px] d-mono uppercase tracking-[0.06em] rounded transition-colors " +
                (range === r ? "bg-white/[0.08] text-white" : "text-white/45 hover:text-white")
              }
              data-testid={`audit-range-${r}`}
            >
              {r}
            </button>
          ))}
        </div>
        <span className="text-[11px] d-mono text-white/45">
          {filtered.length} / {entries.length} shown
        </span>
      </div>

      {loading && (
        <div className="px-8 py-10 flex items-center gap-2 text-white/55 text-[13px]">
          <Loader2 size={14} className="animate-spin" /> Loading…
        </div>
      )}
      {err && (
        <div className="mx-8 mt-6 flex items-center gap-2 text-rose-400 text-[13px] border border-rose-900 rounded p-3">
          <AlertTriangle size={14} /> {err}
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="mx-8 mt-12 border border-white/[0.06] rounded p-10 text-center">
          <p className="text-[13px] text-white/55">No audit entries match these filters.</p>
        </div>
      )}
      {!loading && filtered.length > 0 && (
        <div>
          {filtered.map((a) => (
            <div
              key={a.id}
              className="grid grid-cols-[170px_120px_minmax(0,1fr)_minmax(0,1fr)] gap-4 px-8 py-3 border-b border-white/[0.04] text-[12px] hover:bg-white/[0.02]"
            >
              <span className="d-mono text-white/45">{fmtDate(a.createdAt)}</span>
              <span className="text-white/65 truncate">{a.actor}</span>
              <span className="d-mono truncate" style={{ color: ACTION_COLOR[a.action] || "rgba(255,255,255,0.85)" }}>{a.action}</span>
              <span className="d-mono text-white/55 truncate">{a.targetType}/{a.targetId}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
