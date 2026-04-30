/**
 * Raft Repos list + Repo detail. Themed to match Inbox/IssueDetail.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Search, RefreshCw, Loader2, AlertTriangle, ChevronRight, ChevronLeft,
  GitBranch, Copy, Check, RotateCcw, ExternalLink,
} from "lucide-react";
import { api, fmtRelative, stateTone } from "@/dashboard/raft/api";

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

export const RaftRepos = () => {
  const navigate = useNavigate();
  const [repos, setRepos] = useState([]);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState("");

  const reload = async () => {
    setLoading(true);
    try {
      const [r, m] = await Promise.all([api.repos(), api.me().catch(() => null)]);
      setRepos(r?.data?.repos ?? []);
      setMe(m?.data ?? null);
      setErr(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { reload(); }, []);
  const installUrl = me?.githubApp?.installUrl;

  const filtered = useMemo(() => {
    const ql = q.toLowerCase();
    return ql
      ? repos.filter((r) => (r.fullName ?? "").toLowerCase().includes(ql))
      : repos;
  }, [repos, q]);

  return (
    <div data-testid="raft-repos">
      <div className="flex items-end justify-between px-8 pt-10 pb-4 border-b border-white/[0.04]">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight text-white">Repositories</h1>
          <p className="mt-1 text-[13px] text-white/55">Repos the Raft GitHub App is installed on.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/40" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search repos…"
              className="bg-white/[0.04] border border-white/[0.06] rounded h-8 pl-8 pr-2 text-[12.5px] text-white/85 placeholder-white/30 outline-none focus:border-white/20 w-64"
            />
          </div>
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded h-8 px-3 text-[12px] font-medium border border-[#ED462D]/40 text-white bg-[#ED462D]/10 hover:bg-[#ED462D]/20 transition-colors"
            >
              + Install on a repo
            </a>
          )}
          <button onClick={reload} className="fc-btn-icon" title="Refresh"><RefreshCw size={14} /></button>
        </div>
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
      {!loading && !err && filtered.length === 0 && (
        <div className="mx-8 mt-12 border border-white/[0.06] rounded p-10 text-center">
          <p className="text-[13px] text-white/55">No repositories found.</p>
          {installUrl && (
            <a
              href={installUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-1.5 rounded h-9 px-4 text-[13px] font-medium border border-[#ED462D]/40 text-white bg-[#ED462D]/10 hover:bg-[#ED462D]/20 transition-colors"
            >
              Install Raft on a repo →
            </a>
          )}
        </div>
      )}
      {!loading && filtered.length > 0 && (
        <div>
          {filtered.map((r) => (
            <button
              key={r.id}
              onClick={() => navigate(`/dashboard/repo/${encodeURIComponent(r.id)}`)}
              className="grid w-full grid-cols-[16px_minmax(0,1fr)_140px_180px_14px] items-center gap-4 px-8 py-4 text-left border-b border-white/[0.04] hover:bg-white/[0.02]"
              data-testid={`repo-row-${r.id}`}
            >
              <GitBranch size={14} className="text-white/45" />
              <span className="text-[13.5px] font-medium text-white truncate">{r.fullName}</span>
              <span className="d-mono text-[12px] text-white/55">{r.defaultBranch}</span>
              <span className="d-mono text-[11.5px] text-white/45 truncate">install {r.installationId}</span>
              <ChevronRight size={12} className="text-white/30" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const RaftRepoDetail = () => {
  // See PrEnvDetail — splat route avoids %2F-decoding breakage.
  const params = useParams();
  const id = decodeURIComponent(params["*"] ?? "");
  const navigate = useNavigate();
  const [repo, setRepo] = useState(null);
  const [prs, setPrs] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [rotating, setRotating] = useState(false);
  const [newToken, setNewToken] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    Promise.all([api.repo(id), api.repoStats(id).catch(() => null)])
      .then(([r, s]) => {
        setRepo(r?.data?.repo ?? null);
        setPrs(r?.data?.prs ?? []);
        setStats(s?.data ?? null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  const onRotate = async () => {
    if (!window.confirm("Rotate the upload token? The previous token stops working immediately.")) return;
    setRotating(true);
    try {
      const r = await api.rotateUploadToken(id);
      if (r?.data?.upload_token) setNewToken(r.data.upload_token);
    } catch (e) {
      window.alert(String(e));
    } finally {
      setRotating(false);
    }
  };

  const copyTok = () => {
    if (!newToken) return;
    navigator.clipboard.writeText(newToken);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (loading) return <div className="px-8 pt-12 flex items-center gap-2 text-white/55 text-[13px]"><Loader2 size={14} className="animate-spin" /> Loading…</div>;
  if (err) return <div className="px-8 pt-12 mx-8 flex items-center gap-2 text-rose-400 text-[13px] border border-rose-900 rounded p-3"><AlertTriangle size={14} /> {err}</div>;
  if (!repo) return <div className="px-8 pt-12 text-white/55 text-[13px]">Repo not found.</div>;

  return (
    <div data-testid="raft-repo-detail">
      <div className="px-8 pt-8 pb-3 border-b border-white/[0.04]">
        <div className="flex items-center text-[12px] text-white/45 gap-1">
          <button onClick={() => navigate("/dashboard")} className="hover:text-white/85">Dashboard</button>
          <ChevronRight size={11} className="text-white/30" />
          <button onClick={() => navigate("/dashboard/repos")} className="hover:text-white/85">Repositories</button>
          <ChevronRight size={11} className="text-white/30" />
          <span className="text-white/85">{repo.fullName}</span>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="fc-btn-icon"><ChevronLeft size={14} /></button>
          <h1 className="text-[22px] font-semibold tracking-tight text-white">{repo.fullName}</h1>
        </div>
        <p className="mt-1 text-[12px] text-white/45">
          Default branch <span className="d-mono text-white/65">{repo.defaultBranch}</span>
          {" · "}installation <span className="d-mono text-white/65">{repo.installationId}</span>
        </p>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-0 border-b border-white/[0.04]">
        <div className="px-8 py-7 space-y-7 border-r border-white/[0.04]">
          {stats && (
            <section>
              <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Repo stats</h2>
              <div className="grid grid-cols-5 gap-3">
                {[
                  { label: "Total", v: stats.counts?.total_pr_envs ?? 0, color: "text-white" },
                  { label: "Ready", v: stats.counts?.ready ?? 0, color: "text-[#5BE08F]" },
                  { label: "In flight", v: stats.counts?.in_flight ?? 0, color: "text-[#EAB308]" },
                  { label: "Failed", v: stats.counts?.failed ?? 0, color: "text-[#FF8A75]" },
                  { label: "Torn down", v: stats.counts?.torn_down ?? 0, color: "text-white/55" },
                ].map((s) => (
                  <div key={s.label} className="border border-white/[0.06] rounded p-3">
                    <div className="text-[10.5px] uppercase tracking-[0.08em] text-white/45 d-mono">{s.label}</div>
                    <div className={"mt-2 d-mono text-[22px] font-semibold " + s.color}>{s.v}</div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {stats?.recent_activity?.length > 0 && (
            <section>
              <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">Recent activity</h2>
              <div className="border border-white/[0.06] rounded">
                {stats.recent_activity.slice(0, 12).map((a) => (
                  <div key={a.id} className="grid grid-cols-[160px_120px_minmax(0,1fr)] gap-3 px-4 py-2 text-[11.5px] border-b border-white/[0.04] last:border-b-0">
                    <span className="d-mono text-white/45">{new Date((a.created_at ?? 0) * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                    <span className="text-white/65">{a.actor}</span>
                    <span className="d-mono text-white/85">{a.action}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h2 className="mb-3 text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">PR environments</h2>
            {prs.length === 0 ? (
              <div className="border border-white/[0.06] rounded p-8 text-center text-[13px] text-white/55">
                No PR envs yet for this repo.
              </div>
            ) : (
              <div className="border border-white/[0.06] rounded">
                {prs.map((pr) => (
                  <button
                    key={pr.id}
                    onClick={() => navigate(`/dashboard/pr/${encodeURIComponent(pr.id)}`)}
                    className="grid w-full grid-cols-[16px_70px_minmax(0,1fr)_120px_100px_14px] items-center gap-4 px-4 py-3.5 text-left border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.02]"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#ED462D]" />
                    <span className="d-mono text-[12px] text-white/55">PR #{pr.prNumber}</span>
                    <StatusBadge status={pr.state} tone={stateTone(pr.state)} />
                    <span className="d-mono text-[12px] text-white/55">{pr.headSha?.slice(0, 7) ?? "—"}</span>
                    <span className="text-right text-[12px] text-white/45">{fmtRelative(pr.lastActivityAt)}</span>
                    <ChevronRight size={12} className="text-white/30" />
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
        <aside className="bg-white/[0.012] px-6 py-7 space-y-7">
          <section>
            <h3 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Upload token</h3>
            <p className="text-[11.5px] text-white/55 mb-3">
              Used by the customer-side GitHub Action to upload bundles. Hash:{" "}
              <span className="d-mono text-white/85">{repo.uploadTokenHash?.slice(0, 14)}…</span>
            </p>
            {newToken && (
              <div className="border border-emerald-700 rounded p-3 bg-emerald-950/30 mb-3">
                <div className="text-[10.5px] text-[#5BE08F] mb-1 uppercase tracking-wider">New token (shown once)</div>
                <div className="flex items-center gap-2">
                  <code className="text-[10.5px] text-emerald-100 break-all flex-1 d-mono">{newToken}</code>
                  <button onClick={copyTok} className="text-[#5BE08F] hover:text-emerald-200">
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              </div>
            )}
            <button
              onClick={onRotate}
              disabled={rotating}
              className="inline-flex items-center gap-1.5 rounded h-8 px-3 text-[12px] font-medium border border-white/[0.10] text-white/85 hover:bg-white/[0.04] disabled:opacity-50"
            >
              <RotateCcw size={12} className={rotating ? "animate-spin" : ""} />
              {rotating ? "Rotating…" : "Rotate upload token"}
            </button>
          </section>

          <section>
            <h3 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold mb-3">Bases</h3>
            <dl className="text-[11.5px] space-y-2">
              <div className="flex justify-between"><dt className="text-white/55">D1</dt><dd className="d-mono text-white/85">{repo.baseD1Id ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">KV</dt><dd className="d-mono text-white/85">{repo.baseKvId ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">Queue</dt><dd className="d-mono text-white/85">{repo.baseQueueName ?? "—"}</dd></div>
              <div className="flex justify-between"><dt className="text-white/55">DO classes</dt><dd className="d-mono text-white/85">{(repo.doClassNames ?? []).join(", ") || "—"}</dd></div>
            </dl>
          </section>

          <section>
            <a
              href={`https://github.com/${repo.fullName}`}
              target="_blank"
              rel="noreferrer"
              className="d-mono text-[12px] text-[#ED462D] hover:text-[#ff7a5c] inline-flex items-center gap-1"
            >
              github.com/{repo.fullName}
              <ExternalLink size={11} />
            </a>
          </section>
        </aside>
      </div>
    </div>
  );
};
