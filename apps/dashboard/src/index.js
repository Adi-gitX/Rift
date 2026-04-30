import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import "@/index.css";
import App from "@/App";
import Dashboard from "@/Dashboard";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/dashboard"            element={<Dashboard />} />
        <Route path="/dashboard/pr-envs"    element={<Dashboard />} />
        {/* Splat routes: PR / repo IDs contain `/` (e.g. "Adi-gitX/raft-demo-target")
            and Chrome decodes %2F → / in the address bar after navigation, which
            breaks `:id` segment matching. Splat captures the rest. */}
        <Route path="/dashboard/pr/*"       element={<Dashboard />} />
        <Route path="/dashboard/repos"      element={<Dashboard />} />
        <Route path="/dashboard/repo/*"     element={<Dashboard />} />
        <Route path="/dashboard/audit"      element={<Dashboard />} />
        <Route path="/dashboard/system"     element={<Dashboard />} />
        <Route path="/dashboard/settings"   element={<Dashboard />} />
        <Route path="/dashboard/status"     element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
