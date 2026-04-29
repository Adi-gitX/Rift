import React, { useEffect, useState } from "react";
import { useLocation, useNavigate, useMatch } from "react-router-dom";
import { Toaster } from "sonner";
import { RaftShell } from "@/dashboard/Shell";
import { RaftOverview } from "@/dashboard/raft/Overview";
import { RaftPrEnvList } from "@/dashboard/raft/PrEnvList";
import { RaftPrEnvDetail } from "@/dashboard/raft/PrEnvDetail";
import { RaftRepos, RaftRepoDetail } from "@/dashboard/raft/Repos";
import { RaftSettings } from "@/dashboard/raft/Settings";
import { RaftAudit } from "@/dashboard/raft/Audit";
import { RaftSystem } from "@/dashboard/raft/System";
import { RaftStatus } from "@/dashboard/raft/Status";

const PAGE_REGISTRY = {
  overview:  () => <RaftOverview />,
  prs:       () => <RaftPrEnvList />,
  repos:     () => <RaftRepos />,
  audit:     () => <RaftAudit />,
  system:    () => <RaftSystem />,
  settings:  () => <RaftSettings />,
  whatsnew:  () => <RaftStatus />,
};

const Dashboard = () => {
  const loc = useLocation();
  const navigate = useNavigate();
  const matchPr = useMatch("/dashboard/pr/:id");
  const matchRepo = useMatch("/dashboard/repo/:id");

  const initialActive = (() => {
    if (matchPr) return "prs";
    if (matchRepo) return "repos";
    return "overview";
  })();
  const [active, setActive] = useState(initialActive);
  useEffect(() => {
    if (matchPr) setActive("prs");
    else if (matchRepo) setActive("repos");
  }, [matchPr, matchRepo]);

  const onNav = (key) => {
    setActive(key);
    if (key === "overview")    navigate("/dashboard");
    else if (key === "prs")    navigate("/dashboard/pr-envs");
    else if (key === "repos")  navigate("/dashboard/repos");
    else if (key === "audit")  navigate("/dashboard/audit");
    else if (key === "system") navigate("/dashboard/system");
    else if (key === "settings") navigate("/dashboard/settings");
    else if (key === "whatsnew") navigate("/dashboard/status");
  };

  const renderPage = () => {
    if (matchPr)   return <RaftPrEnvDetail />;
    if (matchRepo) return <RaftRepoDetail />;
    const path = loc.pathname.replace(/\/$/, "");
    if (path.endsWith("/pr-envs"))  return <RaftPrEnvList />;
    if (path.endsWith("/repos"))    return <RaftRepos />;
    if (path.endsWith("/audit"))    return <RaftAudit />;
    if (path.endsWith("/system"))   return <RaftSystem />;
    if (path.endsWith("/settings")) return <RaftSettings />;
    if (path.endsWith("/status"))   return <RaftStatus />;
    const builder = PAGE_REGISTRY[active];
    return builder ? builder() : <RaftOverview />;
  };

  return (
    <>
      <RaftShell active={active} onNav={onNav}>
        {renderPage()}
      </RaftShell>
      <Toaster
        theme="dark"
        position="bottom-right"
        toastOptions={{
          style: { background: "#0e0e0e", border: "1px solid #2a2a2a", color: "#ffffff" },
        }}
      />
    </>
  );
};

export default Dashboard;
