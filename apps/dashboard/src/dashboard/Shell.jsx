/**
 * RaftShell — sidebar + top header + main content slot.
 *
 * The visual system uses CSS classes prefixed `fc-*` and `d-*` from
 * raft-shell.css and dashboard.css. The prefixes are legacy (the design
 * tokens were originally crafted for a Firecrawl template) — they're
 * kept as private internal identifiers because they're never visible to
 * end users and renaming all 200+ rules would just churn diffs without
 * adding value.
 */
import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ChevronDown,
  ChevronsLeft,
  Bell,
  HelpCircle,
  BookOpen,
  ExternalLink,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  NAV_OVERVIEW,
  NAV_PLAYGROUND,
  NAV_RESEARCH,
  NAV_ACCOUNT,
  NAV_FOOTER,
} from "@/dashboard/nav";
import { api } from "@/dashboard/raft/api";
import "@/dashboard/raft-shell.css";

/* ───────────── Sidebar ───────────── */

const NavBtn = ({ item, active, onClick, collapsed }) => (
  <button
    type="button"
    onClick={onClick}
    className={cn("fc-nav-btn", active && "active", collapsed && "collapsed")}
    data-testid={`nav-${item.key}`}
    title={collapsed ? item.label : undefined}
  >
    <span className="shrink-0 text-[#a0a0a0]">{item.icon}</span>
    {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
    {!collapsed && item.badge && <span className="fc-pill">{item.badge}</span>}
  </button>
);

const SectionLabel = ({ children, collapsed }) =>
  collapsed ? <div className="fc-nav-section-rule" /> : <div className="fc-nav-section">{children}</div>;

export const SIDEBAR_W = 256;
export const SIDEBAR_W_COLLAPSED = 64;

const RaftMark = () => (
  // 22×24 SVG matching the original flame footprint so layout stays unchanged.
  <svg width="22" height="24" viewBox="0 0 22 24" fill="none" aria-label="raft">
    {/* Three nested squares = per-PR isolation */}
    <rect x="2"  y="2"  width="18" height="18" stroke="#F6821F" strokeWidth="1.5" fill="none" />
    <rect x="6"  y="6"  width="10" height="10" stroke="#F6821F" strokeWidth="1.5" fill="none" opacity="0.65" />
    <rect x="9.5" y="9.5" width="3"  height="3"  fill="#F6821F" />
  </svg>
);

const Sidebar = ({ active, onNav, sessionEmail, collapsed, onToggle }) => (
  <aside
    className="fixed left-0 top-0 z-30 flex h-screen flex-col border-r border-[#1f1f1f] bg-[#0a0a0a] transition-[width] duration-150"
    style={{ width: collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W }}
    data-testid="dashboard-sidebar"
  >
    {/* Brand */}
    <div className={cn("flex h-[64px] items-center border-b border-[#1f1f1f]", collapsed ? "justify-center px-0" : "px-4")}>
      <Link to="/" className="flex items-center gap-2 group" data-testid="sidebar-home-link">
        <span className="inline-flex h-7 w-7 items-center justify-center text-[#F6821F]">
          <RaftMark />
        </span>
        {!collapsed && <span className="text-[17px] font-semibold tracking-tight text-white">raft</span>}
        {!collapsed && <span className="ml-1 text-[10px] font-mono text-white/30">control plane</span>}
      </Link>
    </div>

    {/* Nav */}
    <nav className={cn("flex-1 overflow-y-auto pt-4 pb-2", collapsed ? "px-2" : "px-3")}>
      <NavBtn item={NAV_OVERVIEW} active={active === "overview"} onClick={() => onNav("overview")} collapsed={collapsed} />

      <SectionLabel collapsed={collapsed}>Provisioning</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {NAV_PLAYGROUND.map((it) => (
          <NavBtn key={it.key} item={it} active={active === it.key} onClick={() => onNav(it.key)} collapsed={collapsed} />
        ))}
      </div>

      <SectionLabel collapsed={collapsed}>Telemetry</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {NAV_RESEARCH.map((it) => (
          <NavBtn key={it.key} item={it} active={active === it.key} onClick={() => onNav(it.key)} collapsed={collapsed} />
        ))}
      </div>

      <SectionLabel collapsed={collapsed}>Operator</SectionLabel>
      <div className="flex flex-col gap-0.5">
        {NAV_ACCOUNT.map((it) => (
          <NavBtn key={it.key} item={it} active={active === it.key} onClick={() => onNav(it.key)} collapsed={collapsed} />
        ))}
      </div>
    </nav>

    {/* Footer */}
    <div className={cn("border-t border-[#1f1f1f] pt-3 pb-3 flex flex-col gap-1", collapsed ? "px-2 items-center" : "px-3")}>
      {NAV_FOOTER.map((it) => (
        <NavBtn key={it.key} item={it} active={active === it.key} onClick={() => onNav(it.key)} collapsed={collapsed} />
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-white/[0.04]"
            data-testid="sidebar-user"
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#F6821F] to-[#C2410C] text-[10.5px] font-semibold text-white">
              {(sessionEmail ?? "?").slice(0, 2).toUpperCase()}
            </span>
            {!collapsed && <span className="flex-1 truncate text-[12.5px] text-white">{sessionEmail ?? "—"}</span>}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-[220px] border-[#2a2a2a] bg-[#0e0e0e] text-white/85">
          <DropdownMenuLabel className="text-[12px] text-white">{sessionEmail ?? "no session"}</DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-[#2a2a2a]" />
          <DropdownMenuItem
            className="focus:bg-white/[0.06] focus:text-white"
            onSelect={() => window.open("https://github.com/Adi-gitX/Rift", "_blank")}
          >
            GitHub repo
          </DropdownMenuItem>
          <DropdownMenuItem
            className="focus:bg-white/[0.06] focus:text-white"
            onSelect={() => fetch("/logout", { method: "POST", credentials: "same-origin" }).then(() => (window.location.href = "/login"))}
          >
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        onClick={onToggle}
        className="mt-1 flex items-center gap-2 rounded-md px-2 py-2 text-left text-[12.5px] text-[#a0a0a0] hover:bg-white/[0.04] hover:text-white"
        data-testid="sidebar-collapse"
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <ChevronsLeft size={15} className={cn("transition-transform", collapsed && "rotate-180")} />
        {!collapsed && <span>Collapse</span>}
      </button>
    </div>
  </aside>
);

/* ───────────── Top Header ───────────── */

const TopHeader = ({ health, accountId, sidebarWidth }) => (
  <header
    className="fixed top-0 right-0 z-20 flex h-[64px] items-center justify-between gap-3 border-b border-[#1f1f1f] bg-[#0a0a0a] pl-6 pr-6 transition-[left] duration-150"
    style={{ left: sidebarWidth }}
  >
    {/* Account / installation context */}
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex items-center gap-2 rounded-md border border-[#2a2a2a] bg-[#0e0e0e] px-2.5 py-1.5 text-left transition-colors hover:bg-[#141414]"
          data-testid="account-switcher"
        >
          <span className="fc-team-avatar">CF</span>
          <span className="text-[13px] font-medium text-white">Cloudflare account · {accountId ? `${accountId.slice(0, 8)}…` : "—"}</span>
          <ChevronDown size={13} className="text-[#888]" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[260px] border-[#2a2a2a] bg-[#0e0e0e] text-white/85">
        <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.14em] text-white/40">
          Connected accounts
        </DropdownMenuLabel>
        <DropdownMenuItem className="gap-2 focus:bg-white/[0.06] focus:text-white">
          <span className="fc-team-avatar">CF</span>
          {accountId ?? "—"}
        </DropdownMenuItem>
        <DropdownMenuSeparator className="bg-[#2a2a2a]" />
        <DropdownMenuItem
          className="text-white/55 focus:bg-white/[0.06] focus:text-white"
          onSelect={() => toast.message("Per-installation tokens land in v2.")}
        >
          + Connect another account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>

    {/* Right action group */}
    <div className="flex items-center gap-2">
      {/* Live worker status pill */}
      <div className="flex items-center gap-3 px-2.5 h-8 border border-[#2a2a2a] rounded-md text-[11px] d-mono text-white/65" title="Worker health snapshot">
        <Activity size={12} className="text-white/45" />
        <span className="flex items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", health.control === "ok" ? "bg-[#5BE08F]" : "bg-rose-500")} />
          control
        </span>
        <span className="flex items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", health.dispatcher === "ok" ? "bg-[#5BE08F]" : "bg-amber-400")} />
          dispatcher
        </span>
        <span className="flex items-center gap-1">
          <span className={cn("h-1.5 w-1.5 rounded-full", health.tail === "ok" ? "bg-[#5BE08F]" : "bg-amber-400")} />
          tail
        </span>
      </div>

      <button
        className="fc-btn-icon"
        onClick={() => toast.message("No alerts", { description: "All recent provisioning runs succeeded." })}
        data-testid="header-notifications"
        aria-label="Notifications"
      >
        <Bell size={15} strokeWidth={1.75} />
      </button>
      <button
        className="fc-btn fc-btn-ghost"
        onClick={() => window.open("https://github.com/Adi-gitX/Rift/blob/main/rift_PRD.md", "_blank")}
        data-testid="header-prd"
      >
        <BookOpen size={14} strokeWidth={1.75} />
        PRD
      </button>
      <button
        className="fc-btn fc-btn-ghost"
        onClick={() => window.open("https://github.com/Adi-gitX/Rift#readme", "_blank")}
        data-testid="header-help"
      >
        <HelpCircle size={14} strokeWidth={1.75} />
        Docs
      </button>
      <a
        href="https://github.com/Adi-gitX/Rift"
        target="_blank"
        rel="noreferrer"
        className="fc-btn fc-btn-orange ml-1"
        data-testid="header-github"
      >
        <ExternalLink size={13} strokeWidth={2.5} />
        GitHub
      </a>
    </div>
  </header>
);

/* ───────────── Shell ───────────── */

export const RaftShell = ({ children, active = "overview", onNav = () => {} }) => {
  const [sessionEmail, setSessionEmail] = useState(null);
  const [accountId, setAccountId] = useState(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const saved = window.localStorage.getItem("raft.sidebar.collapsed");
      if (saved !== null) return saved === "1";
    } catch {}
    return typeof window !== "undefined" && window.innerWidth < 1100;
  });
  const toggleCollapsed = () => {
    setCollapsed((v) => {
      try { window.localStorage.setItem("raft.sidebar.collapsed", v ? "0" : "1"); } catch {}
      return !v;
    });
  };
  const sidebarWidth = collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W;
  const [health, setHealth] = useState({ control: "ok", dispatcher: "?", tail: "?" });

  useEffect(() => {
    api.me()
      .then((r) => {
        setSessionEmail(r?.data?.email ?? null);
        setAccountId(r?.data?.cloudflare?.accountId ?? null);
      })
      .catch(() => {});
    api.health()
      .then((r) => {
        if (r?.data) {
          setHealth({
            control: r.data.control?.status === "ok" ? "ok" : "down",
            dispatcher: r.data.dispatcher?.status === "ok" ? "ok" : "warn",
            tail: r.data.tail?.status === "ok" ? "ok" : "warn",
          });
        }
      })
      .catch(() => {});
  }, []);

  return (
    <div className="fc-shell relative flex min-h-screen w-full bg-[#0a0a0a]">
      <span className="fc-bg-glow" aria-hidden />
      <Sidebar active={active} onNav={onNav} sessionEmail={sessionEmail} collapsed={collapsed} onToggle={toggleCollapsed} />
      <TopHeader health={health} accountId={accountId} sidebarWidth={sidebarWidth} />
      <main
        className="relative z-10 flex-1 min-w-0 transition-[margin] duration-150"
        style={{ marginLeft: sidebarWidth, paddingTop: 64 }}
        data-testid="dashboard-main"
      >
        {children}
      </main>
    </div>
  );
};
