// Raft dashboard nav + content data, served via the RaftShell
// (visual system kept intact — only labels and icons swapped).
import {
  Home,
  GitBranch,
  GitPullRequest,
  ScrollText,
  Settings,
  Activity,
  Megaphone,
  Database,
  Layers,
  ListChecks,
  Cpu,
  Network,
  Radio,
} from "lucide-react";

export const NAV_OVERVIEW = {
  key: "overview",
  label: "Overview",
  icon: <Home size={16} strokeWidth={1.75} />,
};

export const NAV_PLAYGROUND = [
  { key: "prs",   label: "PR environments", icon: <GitPullRequest size={16} strokeWidth={1.75} /> },
  { key: "repos", label: "Repositories",    icon: <GitBranch size={16} strokeWidth={1.75} /> },
];

export const NAV_RESEARCH = [
  { key: "audit",  label: "Audit log", icon: <ScrollText size={16} strokeWidth={1.75} /> },
  { key: "system", label: "System",    icon: <Activity size={16} strokeWidth={1.75} /> },
];

export const NAV_ACCOUNT = [
  { key: "settings", label: "Settings", icon: <Settings size={16} strokeWidth={1.75} /> },
];

export const NAV_FOOTER = [
  { key: "whatsnew", label: "Live status", icon: <Megaphone size={16} strokeWidth={1.75} />, badge: "v3" },
];

/** Cards rendered on the Overview hero — each gets a dot grid + title + desc. */
export const ENDPOINTS = [
  { key: "ready",      title: "Ready",      desc: "Live preview environments serving traffic at *.workers.dev." },
  { key: "inflight",   title: "In flight",  desc: "PRs walking the 5-step alarm-driven provision machine." },
  { key: "failed",     title: "Failed",     desc: "Stuck after exhausting backoff. Inspect → force teardown.", badge: "ALERT" },
  { key: "tornDown",   title: "Torn down",  desc: "Closed PRs whose 9-step destruction completed cleanly." },
];

/** Cloudflare products integrated into Raft — rendered as a logo grid. */
export const INTEGRATIONS = [
  { name: "Workers",  Logo: ({ className }) => <Cpu className={className} /> },
  { name: "D1",       Logo: ({ className }) => <Database className={className} /> },
  { name: "KV",       Logo: ({ className }) => <Layers className={className} /> },
  { name: "Queues",   Logo: ({ className }) => <ListChecks className={className} /> },
  { name: "Durable Objects", Logo: ({ className }) => <Network className={className} /> },
  { name: "Tail",     Logo: ({ className }) => <Radio className={className} /> },
];

/** Provisioning steps timeline shown on Overview / PR detail. */
export const PROVISION_STEPS = [
  { key: "load-config",        label: "load-config",        desc: "Detect customer-bundle / static / fallback at head SHA" },
  { key: "await-bundle",       label: "await-bundle",       desc: "Wait for GH Action upload (≤5min cap, no-op for static)" },
  { key: "provision-resources",label: "provision-resources",desc: "Create D1 + KV + Queue (idempotent, list-then-create)" },
  { key: "fork-base-db",       label: "fork-base-db",       desc: "Export base D1 → import into per-PR D1 (no-op if no base)" },
  { key: "rewrite-bundle",     label: "rewrite-bundle",     desc: "Swap binding IDs, codegen DO wrappers" },
  { key: "upload-script",      label: "upload-script",      desc: "PUT /workers/scripts/{name} + enable subdomain" },
  { key: "route-and-comment",  label: "route-and-comment",  desc: "Write ROUTES KV + sticky PR comment + live probe" },
];

export const TEARDOWN_STEPS = [
  { key: "mark-tearing-down",   label: "mark-tearing-down" },
  { key: "delete-worker-script",label: "delete-worker-script" },
  { key: "delete-d1",           label: "delete-d1" },
  { key: "delete-kv",           label: "delete-kv" },
  { key: "delete-queue",        label: "delete-queue" },
  { key: "purge-bundle-kv",     label: "purge-bundle-kv" },
  { key: "evict-do-shard",      label: "evict-do-shard" },
  { key: "clear-route",         label: "clear-route" },
  { key: "mark-torn-down",      label: "mark-torn-down" },
];

/** 7-day chart axis labels — populated by the API in production. */
export const CHART_DAYS = ["−6d", "−5d", "−4d", "−3d", "−2d", "−1d", "Today"];
