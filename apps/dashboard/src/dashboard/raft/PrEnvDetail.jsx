/**
 * Raft PR-environment detail. Pulls /api/pr-environments/:id (state + audit),
 * /api/pr-environments/:id/runner (live ProvisionRunner DO state + per-step
 * results + error history), and /api/pr-environments/:id/logs every 2 seconds.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ChevronRight, ChevronLeft, ExternalLink, Loader2, AlertTriangle,
  RotateCcw, Trash2, Copy, Check, ChevronDown, ChevronUp,
} from "lucide-react";
import { PROVISION_STEPS, TEARDOWN_STEPS } from "@/dashboard/nav";
import { api, fmtDate, fmtRelative, stateTone } from "@/dashboard/raft/api";
import { StepLatencyBars } from "@/dashboard/raft/charts";

// Cloudflare account id is fetched from /api/me at mount time; never hardcoded.

const StatusBadge = ({ status, tone, big = false }) => {
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
    <span className={`inline-flex items-center gap-2 ${big ? "text-[13.5px]" : "text-[12px]"} font-medium ${textMap[tone] || "text-white/65"}`}>
      {dotMap[tone] || null}
      {status}
    </span>
  );
};

const ResourceRow = ({ label, value, href }) => {
  const [copied, setCopied] = useState(false);
  const onCopy = (e) => {
    e.preventDefault();
    if (!value) return;
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-white/[0.04] last:border-b-0">
      <span className="text-[12px] text-white/55">{label}</span>
      <div className="flex items-center gap-2 max-w-[60%]">
        {value ? (
          <>
            {href ? (
              <a href={href} target="_blank" rel="noreferrer" className="d-mono text-[12px] text-white/90 hover:text-white truncate inline-flex items-center gap-1">
                {value}
                <ExternalLink size={11} className="text-white/45" />
              </a>
            ) : (
              <span className="d-mono text-[12px] text-white/90 truncate">{value}</span>
            )}
            <button onClick={onCopy} className="text-white/30 hover:text-white/70" title="Copy">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </>
        ) : (
          <span className="d-mono text-[12px] text-white/35">— not provisioned</span>
        )}
      </div>
    </div>
  );
};

/** Step row driven by real ProvisionRunner DO state. */
const RunnerStepRow = ({ step, runner, defaultStep }) => {
  const [open, setOpen] = useState(false);
  const cursor = runner?.snapshot?.cursor ?? -1;
  const status = runner?.snapshot?.status ?? null;
  const order = PROVISION_STEPS.findIndex((s) => s.key === step.key);
  const isPast = order < cursor || (status === "succeeded");
  const isCurrent = order === cursor && status === "running";
  const isFailedHere = status === "failed" && order === cursor;
  const result = runner?.stepResults?.[step.key];

  const stepErrors = (runner?.snapshot?.errorHistory ?? []).filter((e) => e.step === step.key);
  const attempt = stepErrors.length + (isPast ? 1 : isCurrent ? 1 : 0);

  const dotColor = isFailedHere
    ? "#FF8A75"
    : isPast
      ? "#5BE08F"
      : isCurrent
        ? "#ED462D"
        : "rgba(255,255,255,0.18)";

  return (
    <div className="border-b border-white/[0.04] last:border-b-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className="grid w-full grid-cols-[14px_minmax(0,1fr)_70px_70px_14px] items-center gap-3 px-3 py-2.5 text-left hover:bg-white/[0.02]"
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{
            background: dotColor,
            boxShadow: isCurrent ? "0 0 8px rgba(237,70,45,0.7)" : undefined,
          }}
        />
        <div className="min-w-0">
          <div className={`d-mono text-[12.5px] ${isCurrent ? "text-white" : isPast ? "text-white/85" : "text-white/55"}`}>
            {step.label}
          </div>
          {step.desc && <div className="text-[11px] text-white/40 mt-0.5">{step.desc}</div>}
        </div>
        <span className="text-[10.5px] d-mono text-white/45 text-right">
          {attempt > 1 ? `attempt ${attempt}` : isPast ? "1 attempt" : ""}
        </span>
        <span className="text-[10.5px] text-right">
          {isPast    && <span className="text-[#5BE08F]">✓ ok</span>}
          {isCurrent && <span className="text-[#ED462D]">● live</span>}
          {isFailedHere && <span className="text-[#FF8A75]">✕ failed</span>}
          {!isPast && !isCurrent && !isFailedHere && <span className="text-white/30">queued</span>}
        </span>
        {open ? <ChevronUp size={12} className="text-white/35" /> : <ChevronDown size={12} className="text-white/35" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 bg-black/30">
          {result && (
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-white/45 mb-1">Step result</div>
              <pre className="text-[10.5px] text-white/85 d-mono bg-black border border-white/[0.06] rounded p-2 max-h-40 overflow-auto">
{JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
          {stepErrors.length > 0 && (
            <div>
              <div className="text-[10.5px] uppercase tracking-[0.08em] text-[#FF8A75] mb-1">Error history ({stepErrors.length})</div>
              <ul className="space-y-1">
                {stepErrors.map((e, i) => (
                  <li key={i} className="text-[10.5px] d-mono text-white/75 border border-white/[0.06] rounded px-2 py-1.5">
                    <span className="text-white/45">attempt {e.attempt} ·</span> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!result && stepErrors.length === 0 && defaultStep && (
            <div className="text-[11px] text-white/45">No data yet — step hasn't started.</div>
          )}
        </div>
      )}
    </div>
  );
};

/** Teardown step row — driven by real TeardownRunner DO snapshot. */
const TeardownStepRow = ({ step, runner }) => {
  const cursor = runner?.snapshot?.cursor ?? -1;
  const status = runner?.snapshot?.status ?? null;
  const order = TEARDOWN_STEPS.findIndex((s) => s.key === step.key);
  const isPast = order < cursor || status === "succeeded";
  const isCurrent = order === cursor && status === "running";
  const isFailedHere = status === "failed" && order === cursor;
  const dotColor = isFailedHere
    ? "#FF8A75"
    : isPast
      ? "#9aa3a8"
      : isCurrent
        ? "#ED462D"
        : "rgba(255,255,255,0.18)";
  return (
    <div className="grid grid-cols-[14px_minmax(0,1fr)_70px] items-center gap-3 px-3 py-2 border-b border-white/[0.04] last:border-b-0">
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: dotColor, boxShadow: isCurrent ? "0 0 8px rgba(237,70,45,0.6)" : undefined }}
      />
      <div className="min-w-0">
        <div className={`d-mono text-[12.5px] ${isCurrent ? "text-white" : isPast ? "text-white/65" : "text-white/40"}`}>
          {step.label}
        </div>
      </div>
      <span className="text-[10.5px] text-right">
        {isPast       && <span className="text-white/55">✓ done</span>}
        {isCurrent    && <span className="text-[#ED462D]">● live</span>}
        {isFailedHere && <span className="text-[#FF8A75]">✕ failed</span>}
        {!isPast && !isCurrent && !isFailedHere && <span className="text-white/30">queued</span>}
      </span>
    </div>
  );
};

const ActionButton = ({ icon, children, tone = "ghost", onClick, disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className={
      "inline-flex items-center gap-1.5 rounded h-8 px-3 text-[12px] font-medium border transition-colors disabled:opacity-50 " +
      (tone === "danger"
        ? "border-rose-900 text-rose-300 hover:bg-rose-950/40"
        : tone === "primary"
          ? "border-[#ED462D]/40 text-white bg-[#ED462D]/10 hover:bg-[#ED462D]/20"
          : "border-white/[0.10] text-white/85 hover:bg-white/[0.04]")
    }
  >
    {icon}
    {children}
  </button>
);

/**
 * Per-step latency from the runner's persisted timings. Each step records
 * its own startedAt + finishedAt as it runs (see ProvisionRunner.runStep).
 * Falls back to "approximate equal slices" only if no timing data exists
 * (legacy snapshots from before timings were tracked).
 */
const buildLatencySteps = (runner) => {
  const order = PROVISION_STEPS.map((s) => ({ key: s.key, label: s.label }));
  const snap = runner?.snapshot;
  if (!snap) return order.map((s) => ({ ...s, ms: null, status: "queued" }));
  const timings = snap.stepTimings ?? {};
  const cursor = snap.cursor ?? 0;
  const status = snap.status ?? "pending";
  const haveTimings = order.some((s) => timings[s.key]?.startedAt);

  if (haveTimings) {
    return order.map((s, i) => {
      const t = timings[s.key];
      if (t?.finishedAt && t?.startedAt) {
        return { ...s, ms: t.finishedAt - t.startedAt, status: "ok" };
      }
      if (t?.startedAt && i === cursor && status === "running") {
        return { ...s, ms: Math.max(0, Date.now() - t.startedAt), status: "running" };
      }
      if (i === cursor && status === "failed") return { ...s, ms: 0, status: "failed" };
      return { ...s, ms: null, status: "queued" };
    });
  }

  // Legacy fallback — equal slices of total wall-clock.
  const started = snap.startedAt ?? null;
  const finished = snap.finishedAt ?? null;
  const total = started && finished ? finished - started : started ? Math.max(0, Date.now() - started) : 0;
  const completed = status === "succeeded" ? order.length : Math.min(cursor, order.length);
  const perCompleted = completed > 0 ? total / completed : 0;
  return order.map((s, i) => {
    if (i < completed) return { ...s, ms: perCompleted, status: "ok" };
    if (i === cursor && status === "running") return { ...s, ms: total - perCompleted * completed, status: "running" };
    if (i === cursor && status === "failed") return { ...s, ms: 0, status: "failed" };
    return { ...s, ms: null, status: "queued" };
  });
};

export const RaftPrEnvDetail = () => {
  // Splat route: useParams returns the captured wildcard as `*`. We
  // decode it once — Chrome decodes %2F → / in the URL bar after
  // navigation, so the splat may carry literal slashes (which is fine,
  // they round-trip back into the prEnvId verbatim).
  const params = useParams();
  const id = decodeURIComponent(params["*"] ?? "");
  const navigate = useNavigate();
  const [pr, setPr] = useState(null);
  const [audit, setAudit] = useState([]);
  const [logs, setLogs] = useState([]);
  const [runner, setRunner] = useState(null);
  const [teardownRunner, setTeardownRunner] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [acting, setActing] = useState(false);
  const pollRef = useRef(null);

  // Fetch /api/me once for the Cloudflare account context (used to build
  // dash.cloudflare.com deep-links). Doesn't poll — it never changes.
  useEffect(() => {
    api.me().then((m) => setMe(m?.data ?? null)).catch(() => {});
  }, []);

  const refresh = async () => {
    try {
      const [pe, lr, rn, tr] = await Promise.all([
        api.prEnvironment(id),
        api.prEnvironmentLogs(id).catch(() => null),
        api.runnerState(id).catch(() => null),
        api.teardownRunnerState(id).catch(() => null),
      ]);
      if (pe?.data) {
        setPr(pe.data.prEnvironment ?? null);
        setAudit(pe.data.audit ?? []);
      }
      if (lr?.data) setLogs(lr.data.logs ?? []);
      if (rn?.data) setRunner(rn.data);
      if (tr?.data) setTeardownRunner(tr.data);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    }
  };

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
    pollRef.current = setInterval(refresh, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onTeardown = async () => {
    if (!window.confirm("Force teardown this PR environment?")) return;
    setActing(true);
    try { await api.teardown(id); setTimeout(refresh, 500); } catch (e) { window.alert(String(e)); }
    setActing(false);
  };
  const onRedeploy = async () => {
    setActing(true);
    try { await api.redeploy(id); setTimeout(refresh, 500); } catch (e) { window.alert(String(e)); }
    setActing(false);
  };

  const elapsedMs = useMemo(() => {
    if (!runner?.snapshot?.startedAt) return null;
    const end = runner.snapshot.finishedAt ?? Date.now();
    return Math.max(0, end - runner.snapshot.startedAt);
  }, [runner]);

  if (loading && !pr) {
    return (
      <div className="px-8 pt-12 flex items-center gap-2 text-white/55 text-[13px]">
        <Loader2 size={14} className="animate-spin" /> Loading…
      </div>
    );
  }
  if (err && !pr) {
    return (
      <div className="px-8 pt-12 flex items-center gap-2 text-rose-400 text-[13px] border border-rose-900 rounded p-3 mx-8">
        <AlertTriangle size={14} /> {err}
      </div>
    );
  }
  if (!pr) return <div className="px-8 pt-12 text-white/55 text-[13px]">PR environment not found.</div>;

  const acct = me?.cloudflare?.accountId ?? null;
  const cfDashD1 = acct && pr.resources?.d1DatabaseId
    ? `https://dash.cloudflare.com/${acct}/workers/d1/databases/${pr.resources.d1DatabaseId}`
    : null;
  const cfDashKv = acct && pr.resources?.kvNamespaceId
    ? `https://dash.cloudflare.com/${acct}/workers/kv/namespaces/${pr.resources.kvNamespaceId}`
    : null;
  const cfDashWorker = acct && pr.resources?.workerScriptName
    ? `https://dash.cloudflare.com/${acct}/workers/services/view/${pr.resources.workerScriptName}/production`
    : null;
  const cfWorkerLogs = acct && pr.resources?.workerScriptName
    ? `https://dash.cloudflare.com/${acct}/workers/services/view/${pr.resources.workerScriptName}/production/logs`
    : null;

  const tone = stateTone(pr.state);

  return (
    <div data-testid="raft-pr-detail">
      {/* Breadcrumbs + title */}
      <div className="px-8 pt-8 pb-3 border-b border-white/[0.04]">
        <div className="flex items-center text-[12px] text-white/45 gap-1">
          <button onClick={() => navigate("/dashboard")} className="hover:text-white/85">Dashboard</button>
          <ChevronRight size={11} className="text-white/30" />
          <button onClick={() => navigate("/dashboard/pr-envs")} className="hover:text-white/85">PR environments</button>
          <ChevronRight size={11} className="text-white/30" />
          <span className="text-white/85">{pr.repoId}#{pr.prNumber}</span>
        </div>
        <div className="mt-3 flex items-center gap-4 flex-wrap">
          <button onClick={() => navigate(-1)} className="fc-btn-icon" title="Back"><ChevronLeft size={14} /></button>
          <h1 className="text-[22px] font-semibold tracking-tight text-white">
            {pr.repoId}<span className="text-white/35"> · </span>PR #{pr.prNumber}
          </h1>
          <StatusBadge status={pr.state} tone={tone} big />
          {pr.previewHostname && (
            <a className="d-mono text-[12px] text-[#ED462D] hover:text-[#ff7a5c] inline-flex items-center gap-1" href={pr.previewHostname} target="_blank" rel="noreferrer">
              {pr.previewHostname.replace(/^https?:\/\//, "")}
              <ExternalLink size={11} />
            </a>
          )}
        </div>
        <p className="mt-1 text-[12px] text-white/45">
          head <span className="d-mono text-white/65">{pr.headSha?.slice(0, 7) ?? "—"}</span>
          {" · "}created {fmtDate(pr.createdAt)}
          {pr.readyAt ? <> · ready {fmtRelative(pr.readyAt)}</> : null}
          {elapsedMs !== null && <> · runner {(elapsedMs / 1000).toFixed(1)}s</>}
        </p>
        {(() => {
          const lc = runner?.stepResults?.["load-config"];
          const ab = runner?.stepResults?.["await-bundle"];
          if (!lc?.mode) return null;
          const chips = [];
          if (lc.mode === "customer-bundle") {
            chips.push(
              <div key="mode" className="inline-flex items-center gap-2 rounded border border-[#ED462D]/40 bg-[#ED462D]/10 px-2 py-1 text-[11px] d-mono text-[#ED462D]">
                <span>customer Worker</span>
                {ab?.bundleBytes !== undefined && (
                  <>
                    <span className="text-white/45">·</span>
                    <span className="text-white/85">{(ab.bundleBytes / 1024).toFixed(1)} KB</span>
                  </>
                )}
                {ab?.waitedMs !== undefined && ab.waitedMs > 0 && (
                  <>
                    <span className="text-white/45">·</span>
                    <span className="text-white/65">awaited bundle {(ab.waitedMs / 1000).toFixed(1)}s</span>
                  </>
                )}
              </div>
            );
          } else if (lc.mode === "static") {
            chips.push(
              <div key="mode" className="inline-flex items-center gap-2 rounded border border-emerald-900/60 bg-emerald-950/30 px-2 py-1 text-[11px] d-mono text-[#5BE08F]">
                <span>static site</span>
                <span className="text-white/45">·</span>
                <span className="text-white/85">{lc.staticSynth?.fileCount ?? 0} files</span>
                <span className="text-white/45">·</span>
                <span className="text-white/85">{(((lc.staticSynth?.totalBytes ?? 0)) / 1024).toFixed(1)} KB</span>
                {(lc.staticSynth?.warnings?.length ?? 0) > 0 && (
                  <span className="text-[#EAB308]" title={(lc.staticSynth.warnings ?? []).join(" · ")}>
                    · {lc.staticSynth.warnings.length} warning{lc.staticSynth.warnings.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>
            );
          } else if (lc.mode === "fallback") {
            chips.push(
              <div key="mode" className="inline-flex items-center gap-2 rounded border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-[11px] d-mono text-[#EAB308]">
                <span>configuration needed</span>
                <span className="text-white/45">·</span>
                <span className="text-white/65">add wrangler.jsonc with the Raft GitHub Action, or an index.html</span>
              </div>
            );
          }
          return <div className="mt-2 flex items-center gap-2 flex-wrap">{chips}</div>;
        })()}
      </div>

      {/* Two-column body */}
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-0 border-b border-white/[0.04]">
        {/* Main column */}
        <div className="px-8 py-7 space-y-7 border-r border-white/[0.04]">
          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Resources (per-PR)</h2>
            </div>
            <div className="border border-white/[0.06] rounded px-4">
              <ResourceRow label="D1 database"   value={pr.resources?.d1DatabaseId} href={cfDashD1} />
              <ResourceRow label="KV namespace"  value={pr.resources?.kvNamespaceId} href={cfDashKv} />
              <ResourceRow label="Queue (UUID)"  value={pr.resources?.queueId} />
              <ResourceRow label="Worker script" value={pr.resources?.workerScriptName} href={cfDashWorker} />
              <ResourceRow label="DO scope seed" value={pr.resources?.doNamespaceSeed} />
              <ResourceRow label="R2 prefix"     value={pr.resources?.r2Prefix} />
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">
                Provision steps {runner?.snapshot && <span className="text-white/35 normal-case tracking-normal d-mono ml-2">(runner: {runner.snapshot.status ?? "?"})</span>}
              </h2>
              <span className="text-[10.5px] text-white/35 d-mono">5 alarm-driven steps · idempotent on replay</span>
            </div>
            <div className="border border-white/[0.06] rounded">
              {PROVISION_STEPS.map((s) => (
                <RunnerStepRow key={s.key} step={s} runner={runner} defaultStep={true} />
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">
                Teardown steps {teardownRunner?.snapshot && <span className="text-white/35 normal-case tracking-normal d-mono ml-2">(runner: {teardownRunner.snapshot.status ?? "?"})</span>}
              </h2>
              <span className="text-[10.5px] text-white/35 d-mono">9 destruction steps · 404 = already deleted</span>
            </div>
            <div className="border border-white/[0.06] rounded">
              {TEARDOWN_STEPS.map((s) => (
                <TeardownStepRow key={s.key} step={s} runner={teardownRunner} />
              ))}
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Step latency</h2>
              <span className="text-[10.5px] text-white/35 d-mono">{runner?.snapshot?.startedAt && runner?.snapshot?.finishedAt ? `total ${((runner.snapshot.finishedAt - runner.snapshot.startedAt) / 1000).toFixed(2)}s` : "in flight"}</span>
            </div>
            <div className="border border-white/[0.06] rounded p-4">
              <StepLatencyBars steps={buildLatencySteps(runner)} />
            </div>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Live logs <span className="text-white/35 normal-case tracking-normal d-mono">poll 2s · LogTail DO ring buffer</span></h2>
              {cfWorkerLogs && (
                <a href={cfWorkerLogs} target="_blank" rel="noreferrer" className="text-[11px] text-[#ED462D] hover:text-[#ff7a5c] inline-flex items-center gap-1 d-mono">
                  Open Workers Logs ↗
                </a>
              )}
            </div>
            <pre className="text-[11px] leading-5 text-white/85 max-h-64 overflow-auto bg-black border border-white/[0.06] rounded p-3 d-mono">
{logs.length === 0
  ? "(no log events yet — bind raft-tail as a tail consumer to stream wrangler tail output here)"
  : logs.map((l) =>
      `[${new Date((l.ts ?? 0)).toISOString().slice(11, 19)}]  ${l.scriptName ?? ""}  ${l.msg ?? ""}`,
    ).join("\n")}
            </pre>
          </section>

          <section>
            <h2 className="mb-2 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Audit trail</h2>
            <div className="border border-white/[0.06] rounded">
              {audit.length === 0 && (
                <div className="px-4 py-5 text-[12px] text-white/45 text-center">No audit entries.</div>
              )}
              {audit.slice(0, 50).map((a) => (
                <div key={a.id} className="grid grid-cols-[160px_120px_minmax(0,1fr)] gap-3 px-4 py-2.5 text-[11.5px] border-b border-white/[0.04] last:border-b-0">
                  <span className="d-mono text-white/45">{fmtDate(a.createdAt)}</span>
                  <span className="text-white/65">{a.actor}</span>
                  <span className="d-mono text-white/85">{a.action}</span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Sidebar */}
        <aside className="bg-white/[0.012] px-6 py-7 space-y-7">
          <section>
            <h3 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Actions</h3>
            <div className="flex flex-col gap-2">
              <ActionButton icon={<RotateCcw size={12} />} onClick={onRedeploy} disabled={acting} tone="primary">
                Redeploy
              </ActionButton>
              <ActionButton icon={<Trash2 size={12} />} onClick={onTeardown} disabled={acting} tone="danger">
                Force teardown
              </ActionButton>
            </div>
          </section>

          <section>
            <h3 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Runner</h3>
            <dl className="text-[12px] space-y-2">
              <div className="flex justify-between"><dt className="text-white/55">Status</dt><dd className="d-mono text-white/85">{runner?.snapshot?.status ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Cursor</dt><dd className="d-mono text-white/85">{runner?.snapshot?.cursor ?? "—"} / 5</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Attempts</dt><dd className="d-mono text-white/85">{runner?.snapshot?.attempts ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Errors</dt><dd className="d-mono text-white/85">{(runner?.snapshot?.errorHistory ?? []).length}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Started</dt><dd className="text-white/85">{runner?.snapshot?.startedAt ? fmtDate(runner.snapshot.startedAt / 1000) : "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Finished</dt><dd className="text-white/85">{runner?.snapshot?.finishedAt ? fmtDate(runner.snapshot.finishedAt / 1000) : "—"}</dd></div>
            </dl>
          </section>

          <section>
            <h3 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Lifecycle</h3>
            <dl className="text-[12px] space-y-2">
              <div className="flex justify-between"><dt className="text-white/55">State</dt><dd><StatusBadge status={pr.state} tone={tone} /></dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Created</dt><dd className="text-white/85">{fmtDate(pr.createdAt)}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Last activity</dt><dd className="text-white/85">{fmtRelative(pr.lastActivityAt)}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Ready at</dt><dd className="text-white/85">{pr.readyAt ? fmtDate(pr.readyAt) : "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Torn down</dt><dd className="text-white/85">{pr.tornDownAt ? fmtDate(pr.tornDownAt) : "—"}</dd></div>
            </dl>
          </section>

          <section>
            <h3 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Repo</h3>
            <button
              onClick={() => navigate(`/dashboard/repo/${encodeURIComponent(pr.repoId)}`)}
              className="d-mono text-[12px] text-[#ED462D] hover:text-[#ff7a5c]"
            >
              {pr.repoId} →
            </button>
          </section>
        </aside>
      </div>
    </div>
  );
};
