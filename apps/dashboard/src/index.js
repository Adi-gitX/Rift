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
        <Route path="/dashboard/pr/:id"     element={<Dashboard />} />
        <Route path="/dashboard/repos"      element={<Dashboard />} />
        <Route path="/dashboard/repo/:id"   element={<Dashboard />} />
        <Route path="/dashboard/audit"      element={<Dashboard />} />
        <Route path="/dashboard/system"     element={<Dashboard />} />
        <Route path="/dashboard/settings"   element={<Dashboard />} />
        <Route path="/dashboard/status"     element={<Dashboard />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
