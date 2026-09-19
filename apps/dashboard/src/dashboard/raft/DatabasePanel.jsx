/**
 * Database panel on the PR-environment detail page.
 *
 * Renders the D1 branching + migration preview results straight from the
 * ProvisionRunner's persisted step results (fork-base-db, apply-migrations,
 * snapshot-schema). This is the data-layer story Workers Builds previews
 * cannot tell: the PR ran against a fork of the base DB, these migrations
 * were applied to it, and this is how the schema and row counts differ.
 */
import React from "react";
import { AlertTriangle, Database, GitFork, ShieldAlert, XCircle } from "lucide-react";

const short = (id) => (id && id.length > 12 ? `${id.slice(0, 8)}…` : id || "—");

const StatusPill = ({ status }) => {
  const map = {
    applied: ["text-[#5BE08F]", "applied"],
    failed:  ["text-[#FF8A75]", "failed"],
    skipped: ["text-white/40",  "skipped"],
  };
  const [cls, label] = map[status] || ["text-white/55", status];
  return <span className={`text-[10.5px] d-mono ${cls}`}>{label}</span>;
};

const MigrationList = ({ apply }) => {
  const rows = [
    ...(apply?.alreadyApplied ?? []).map((name) => ({ name, status: "already applied", muted: true })),
    ...(apply?.outcomes ?? []),
  ];
  if (rows.length === 0) {
    return <div className="text-[11.5px] text-white/45 px-3 py-3">No migration files under <span className="d-mono">{apply?.migrationsDir ?? "migrations"}/</span>.</div>;
  }
  return (
    <ul>
      {rows.map((m) => (
        <li key={m.name} className="grid grid-cols-[minmax(0,1fr)_90px_70px] items-center gap-3 px-3 py-2 border-b border-white/[0.04] last:border-b-0">
          <div className="min-w-0">
            <div className={`d-mono text-[12px] truncate ${m.muted ? "text-white/45" : "text-white/90"}`}>{m.name}</div>
            {m.error && <div className="text-[11px] text-[#FF8A75] mt-0.5 break-words">{m.error}</div>}
          </div>
          <span className="text-[10.5px] d-mono text-white/45 text-right">
            {m.statements !== undefined ? `${m.statements} stmt${m.statements === 1 ? "" : "s"}` : ""}
            {m.durationMs !== undefined ? ` · ${m.durationMs} ms` : ""}
          </span>
          <span className="text-right">
            {m.muted ? <span className="text-[10.5px] d-mono text-white/35">on base</span> : <StatusPill status={m.status} />}
          </span>
        </li>
      ))}
    </ul>
  );
};

const DiffRow = ({ sign, kind, detail }) => {
  const tone = sign === "+" ? "text-[#5BE08F]" : sign === "−" ? "text-[#FF8A75]" : "text-[#EAB308]";
  return (
    <li className="grid grid-cols-[18px_80px_minmax(0,1fr)] items-baseline gap-2 px-3 py-1.5 border-b border-white/[0.04] last:border-b-0">
      <span className={`d-mono text-[12px] ${tone}`}>{sign}</span>
      <span className="text-[11px] text-white/45">{kind}</span>
      <span className="d-mono text-[12px] text-white/85 break-words">{detail}</span>
    </li>
  );
};

const SchemaDiff = ({ snap }) => {
  if (!snap) return <div className="text-[11.5px] text-white/45 px-3 py-3">Schema snapshot not taken yet.</div>;
  if (snap.status === "partial") return <div className="text-[11.5px] text-[#FF8A75] px-3 py-3">{snap.error}</div>;
  if (snap.status === "fork-only") {
    return (
      <div className="text-[11.5px] text-white/45 px-3 py-3">
        No base to compare against ({snap.reason}). Fork has {snap.fork?.tables?.length ?? 0} table{(snap.fork?.tables?.length ?? 0) === 1 ? "" : "s"}.
      </div>
    );
  }
  const d = snap.diff;
  if (!d) return null;
  const rows = [
    ...d.tablesAdded.map((t) => ({ sign: "+", kind: "table", detail: t })),
    ...d.tablesRemoved.map((t) => ({ sign: "−", kind: "table", detail: t })),
    ...d.columnsAdded.map((c) => ({ sign: "+", kind: "column", detail: `${c.table}.${c.column} ${c.type}` })),
    ...d.columnsRemoved.map((c) => ({ sign: "−", kind: "column", detail: `${c.table}.${c.column}` })),
    ...d.columnsChanged.map((c) => ({ sign: "~", kind: "column", detail: `${c.table}.${c.column}  ${c.before} → ${c.after}` })),
    ...d.indexesAdded.map((i) => ({ sign: "+", kind: "index", detail: i })),
    ...d.indexesRemoved.map((i) => ({ sign: "−", kind: "index", detail: i })),
    ...d.rowDeltas.map((r) => ({ sign: "~", kind: "rows", detail: `${r.table}  ${r.before ?? 0} → ${r.after ?? 0}` })),
  ];
  if (rows.length === 0) return <div className="text-[11.5px] text-white/45 px-3 py-3">No schema or row-count changes vs base.</div>;
  return <ul>{rows.map((r, i) => <DiffRow key={i} {...r} />)}</ul>;
};

const Warnings = ({ apply }) => {
  const warnings = apply?.warnings ?? [];
  const failed = (apply?.outcomes ?? []).find((o) => o.status === "failed");
  if (warnings.length === 0 && !failed) return null;
  return (
    <ul className="space-y-1.5">
      {failed && (
        <li className="flex items-start gap-2 text-[11.5px] text-[#FF8A75] border border-[#FF8A75]/30 bg-[#FF8A75]/[0.06] rounded px-3 py-2">
          <XCircle size={13} className="mt-0.5 shrink-0" />
          <span><span className="d-mono">{failed.name}</span> failed — {failed.error}</span>
        </li>
      )}
      {warnings.map((w, i) => (
        <li key={i} className={`flex items-start gap-2 text-[11.5px] border rounded px-3 py-2 ${w.severity === "danger" ? "text-[#FF8A75] border-[#FF8A75]/30 bg-[#FF8A75]/[0.06]" : "text-[#EAB308] border-[#EAB308]/30 bg-[#EAB308]/[0.06]"}`}>
          {w.severity === "danger" ? <ShieldAlert size={13} className="mt-0.5 shrink-0" /> : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
          <span>
            <span className="uppercase tracking-[0.06em] text-[10px] mr-1.5">{w.kind}</span>
            in <span className="d-mono">{w.migration}</span>: <span className="d-mono">{w.statement}</span>
          </span>
        </li>
      ))}
    </ul>
  );
};

const Header = ({ children }) => (
  <h2 className="text-[11.5px] uppercase tracking-[0.08em] text-white/55 font-semibold">{children}</h2>
);

export const DatabasePanel = ({ runner }) => {
  const results = runner?.stepResults ?? {};
  const config = results["load-config"];
  const fork = results["fork-base-db"];
  const apply = results["apply-migrations"];
  const snap = results["snapshot-schema"];

  if (!config) return null;
  if (!config.db?.baseDatabaseId && fork?.source !== "forked") {
    return (
      <section>
        <div className="flex items-center justify-between mb-3"><Header>Database</Header></div>
        <div className="border border-white/[0.06] rounded px-4 py-4 text-[12px] text-white/55 flex items-start gap-3">
          <Database size={14} className="mt-0.5 shrink-0 text-white/35" />
          <div>
            No D1 detected in this repo's wrangler config. Add a <span className="d-mono text-white/75">d1_databases</span> entry to
            <span className="d-mono text-white/75"> wrangler.jsonc</span> and Raft will fork it per PR, apply pending
            <span className="d-mono text-white/75"> migrations/*.sql</span>, and diff the schema here.
          </div>
        </div>
      </section>
    );
  }

  const forked = fork?.source === "forked";
  return (
    <section data-testid="database-panel">
      <div className="flex items-center justify-between mb-3">
        <Header>Database · D1 branch for this PR</Header>
        <span className="text-[10.5px] text-white/35 d-mono">
          {apply?.status === "applied" ? `${apply.applied.length} migration${apply.applied.length === 1 ? "" : "s"} applied` : apply?.status === "failed" ? "migration failed" : apply?.status === "noop" ? "up to date" : ""}
        </span>
      </div>

      <div className="border border-white/[0.06] rounded divide-y divide-white/[0.06]">
        <div className="px-4 py-3 flex items-center gap-3 text-[12px]">
          <GitFork size={14} className={forked ? "text-[#5BE08F]" : "text-white/35"} />
          {forked ? (
            <span className="text-white/85">
              Forked from <span className="d-mono">{fork.baseDatabaseName ?? "base"}</span>{" "}
              <span className="d-mono text-white/45">{short(fork.baseDatabaseId)}</span>
              {" → "}
              <span className="d-mono text-white/45">{short(apply?.forkDatabaseId ?? config.db?.baseDatabaseId)}</span>
              {fork.sqlBytes ? <span className="text-white/45"> · {(fork.sqlBytes / 1024).toFixed(1)} KB dump</span> : null}
            </span>
          ) : (
            <span className="text-white/55">Not forked — {fork?.reason ?? "pending"}. Migrations run on an empty D1.</span>
          )}
        </div>

        <div>
          <div className="px-4 pt-3 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-white/45">
            Migrations <span className="d-mono normal-case tracking-normal">({apply?.migrationsDir ?? config.db?.migrationsDir ?? "migrations"}/)</span>
          </div>
          <MigrationList apply={apply} />
        </div>

        <div>
          <div className="px-4 pt-3 pb-1 text-[10.5px] uppercase tracking-[0.08em] text-white/45">Schema diff · fork vs base</div>
          <SchemaDiff snap={snap} />
        </div>

        {(apply?.warnings?.length > 0 || apply?.status === "failed") && (
          <div className="px-4 py-3"><Warnings apply={apply} /></div>
        )}
        {apply?.notes?.length > 0 && (
          <div className="px-4 py-2 text-[10.5px] text-white/35 d-mono">{apply.notes.join(" · ")}</div>
        )}
      </div>
    </section>
  );
};
