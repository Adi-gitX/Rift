/**
 * Raft PR-environment list — modeled on Inbox.jsx (tabs, grid rows, monospace
 * IDs, pulse dots). Filterable by state via tabs.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import { api, fmtRelative, stateTone } from "@/dashboard/raft/api";

const VALID_TABS = new Set(["all", "ready", "inflight", "failed", "tornDown"]);

const PriorityDot = ({ tone }) => (
  <span
    className={
      "inline-block h-1.5 w-1.5 rounded-full " +
      (tone === "high"
        ? "bg-[#ED462D] shadow-[0_0_6px_rgba(237,70,45,0.55)]"
        : tone === "progress"
          ? "bg-[#EAB308]"
          : tone === "done"
            ? "bg-[#5BE08F]"
            : "bg-white/35")
    }
  />
);

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

const Tab = ({ value, current, onClick, label, count }) => (
  <button
    type="button"
    onClick={() => onClick(value)}
    className={
      "relative flex h-9 items-center gap-1.5 px-1 text-[13px] font-medium transition-colors " +
      (current === value ? "text-white" : "text-white/45 hover:text-white/75") +
      " after:absolute after:bottom-[-13px] after:left-0 after:right-0 after:h-[2px] after:bg-[#ED462D] after:opacity-0 " +
      (current === value ? "after:opacity-100" : "")
    }
    data-testid={`tab-${value}`}
  >
    {label}
    {typeof count === "number" && (
      <span
        className={
          "d-mono rounded px-1.5 py-0.5 text-[10.5px] font-medium " +
          (current === value ? "bg-white/[0.10] text-white/85" : "bg-white/[0.04] text-white/40")
        }
      >
        {count}
      </span>
    )}
  </button>
);

const Row = ({ pr, onOpen }) => {
  const tone = stateTone(pr.state);
  // Strip "<installationId>:" prefix for display — operators rarely care
  // about the install id; the repo/PR identity is what matters.
  const displayRepo = (pr.repoId ?? "").includes(":")
    ? pr.repoId.split(":").slice(1).join(":")
    : pr.repoId ?? "";
  const previewHost = pr.previewHostname?.replace(/^https?:\/\//, "") || null;
  return (
    <button
      onClick={() => onOpen(pr.id)}
      className="group flex w-full items-center gap-4 px-8 py-4 text-left border-b border-white/[0.04] transition-colors hover:bg-white/[0.02]"
      data-testid={`pr-row-${pr.id}`}
    >
      <PriorityDot tone={tone} />
      <div className="min-w-0 flex-1">
        {/* Top line: repo + PR number, with status pushed to the right. */}
        <div className="flex items-baseline justify-between gap-4">
          <div className="min-w-0 flex items-baseline gap-2 truncate">
            <span className="text-[13.5px] font-medium text-white truncate">{displayRepo}</span>
            <span className="text-white/30">·</span>
            <span className="text-[13px] text-white/85 d-mono">PR #{pr.prNumber}</span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <StatusBadge status={pr.state} tone={tone} />
            <span className="text-[12px] text-white/45 tabular-nums">{fmtRelative(pr.lastActivityAt)}</span>
          </div>
        </div>
        {/* Bottom line: technical breadcrumbs — sha + preview host. */}
        <div className="mt-1 flex items-center gap-3 text-[11px] text-white/40 d-mono truncate">
          <span>{pr.headSha?.slice(0, 7) ?? "—"}</span>
          {previewHost && (
            <>
              <span className="text-white/20">·</span>
              <span className="truncate">{previewHost}</span>
            </>
          )}
        </div>
      </div>
      <svg width="14" height="14" viewBox="0 0 14 14" className="text-white/30 shrink-0">
        <path d="M5 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    </button>
  );
};

export const RaftPrEnvList = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get("tab");
    return t && VALID_TABS.has(t) ? t : "all";
  })();
  const [prs, setPrs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [tab, setTabState] = useState(initialTab);
  const [q, setQ] = useState("");

  // Keep URL ?tab=... in sync so deep-links (e.g. from Overview stat cards)
  // and browser back/forward both work.
  const setTab = (next) => {
    setTabState(next);
    if (next === "all") {
      const sp = new URLSearchParams(searchParams);
      sp.delete("tab");
      setSearchParams(sp, { replace: true });
    } else {
      setSearchParams({ tab: next }, { replace: true });
    }
  };

  const reload = async () => {
    setLoading(true);
    try {
      const r = await api.prEnvironments();
      setPrs(r?.data?.prs ?? []);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  const counts = useMemo(() => {
    const c = { all: prs.length, ready: 0, inflight: 0, failed: 0, tornDown: 0 };
    for (const p of prs) {
      if (p.state === "ready") c.ready++;
      else if (p.state === "failed") c.failed++;
      else if (p.state === "torn_down") c.tornDown++;
      else c.inflight++;
    }
    return c;
  }, [prs]);

  const filtered = useMemo(() => {
    let xs = prs;
    if (tab === "ready")    xs = xs.filter((p) => p.state === "ready");
    if (tab === "inflight") xs = xs.filter((p) => !["ready", "failed", "torn_down"].includes(p.state));
    if (tab === "failed")   xs = xs.filter((p) => p.state === "failed");
    if (tab === "tornDown") xs = xs.filter((p) => p.state === "torn_down");
    if (q.trim()) {
      const ql = q.toLowerCase();
      xs = xs.filter((p) =>
        (p.repoId ?? "").toLowerCase().includes(ql) ||
        String(p.prNumber).includes(ql) ||
        (p.headSha ?? "").toLowerCase().includes(ql),
      );
    }
    return [...xs].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }, [prs, tab, q]);

  return (
    <div data-testid="raft-pr-list">
      {/* Header */}
      <div className="flex items-end justify-between px-8 pt-10 pb-4 border-b border-white/[0.04]">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">PR environments</h1>
          <p className="mt-1 text-[13px] text-white/55">Every per-PR isolated environment Raft has provisioned.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search repo, PR #, sha…"
              className="bg-white/[0.04] border border-white/[0.06] rounded h-8 pl-8 pr-2 text-[12.5px] text-white/85 placeholder-white/30 outline-none focus:border-white/20 w-64"
              data-testid="pr-search"
            />
          </div>
          <button
            onClick={reload}
            className="fc-btn-icon"
            title="Refresh"
            data-testid="pr-refresh"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      {/* Tabs — horizontally scroll on narrow widths instead of crushing. */}
      <div className="flex items-center gap-7 px-8 border-b border-white/[0.04] overflow-x-auto whitespace-nowrap">
        <Tab value="all"      current={tab} onClick={setTab} label="All"          count={counts.all} />
        <Tab value="ready"    current={tab} onClick={setTab} label="Ready"        count={counts.ready} />
        <Tab value="inflight" current={tab} onClick={setTab} label="In flight"    count={counts.inflight} />
        <Tab value="failed"   current={tab} onClick={setTab} label="Failed"       count={counts.failed} />
        <Tab value="tornDown" current={tab} onClick={setTab} label="Torn down"    count={counts.tornDown} />
      </div>

      {/* Body */}
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
      {!loading && !err && filtered.length === 0 && (
        <div className="mx-8 mt-12 border border-white/[0.06] rounded p-10 text-center">
          <p className="text-[13px] text-white/55">No PR environments match this filter.</p>
        </div>
      )}
      {!loading && filtered.length > 0 && (
        <div className="border-b border-white/[0.04]">
          {filtered.map((pr) => (
            <Row key={pr.id} pr={pr} onOpen={(id) => navigate(`/dashboard/pr/${encodeURIComponent(id)}`)} />
          ))}
        </div>
      )}
    </div>
  );
};
