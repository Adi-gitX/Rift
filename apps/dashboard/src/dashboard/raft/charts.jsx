/**
 * Tiny chart primitives — pure SVG, zero dependencies.
 * Themed for the Raft dashboard (Cloudflare orange + dark surface).
 */
import React from "react";

const C = {
  primary: "#ED462D",
  ok: "#5BE08F",
  warn: "#EAB308",
  fail: "#FF8A75",
  mute: "rgba(255,255,255,0.18)",
  text: "rgba(255,255,255,0.45)",
  grid: "rgba(255,255,255,0.05)",
};

/** Donut with center label. `slices` = [{label, value, color}]. */
export const Donut = ({ slices, total: totalProp, label, sub }) => {
  const total = totalProp ?? slices.reduce((a, s) => a + s.value, 0);
  const R = 44, r = 30, cx = 60, cy = 60;
  if (total === 0) {
    return (
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle cx={cx} cy={cy} r={R} fill="none" stroke={C.mute} strokeWidth={R - r} />
        <text x={cx} y={cy + 1} textAnchor="middle" fontSize="11" fill={C.text} fontFamily="Chivo Mono, ui-monospace, monospace">empty</text>
      </svg>
    );
  }
  let acc = 0;
  const arcs = slices.map((s) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += s.value;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + R * Math.cos(start), y1 = cy + R * Math.sin(start);
    const x2 = cx + R * Math.cos(end),   y2 = cy + R * Math.sin(end);
    const xi1 = cx + r * Math.cos(end),  yi1 = cy + r * Math.sin(end);
    const xi2 = cx + r * Math.cos(start),yi2 = cy + r * Math.sin(start);
    return {
      d: `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${R} ${R} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${xi1.toFixed(2)} ${yi1.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${xi2.toFixed(2)} ${yi2.toFixed(2)} Z`,
      color: s.color,
      key: s.label,
    };
  });
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" className="block">
      {arcs.map((a) => (
        <path key={a.key} d={a.d} fill={a.color} />
      ))}
      {label !== undefined && (
        <>
          <text x={cx} y={cy - 2} textAnchor="middle" fontSize="20" fill="#fff" fontWeight="600" fontFamily="Chivo Mono, ui-monospace, monospace">{label}</text>
          {sub && <text x={cx} y={cy + 14} textAnchor="middle" fontSize="9" fill={C.text} fontFamily="Chivo Mono, ui-monospace, monospace" letterSpacing="0.08em">{sub}</text>}
        </>
      )}
    </svg>
  );
};

/** Horizontal stacked bar (for state distribution etc.). */
export const StackedBar = ({ slices, height = 6, total: totalProp }) => {
  const total = totalProp ?? slices.reduce((a, s) => a + s.value, 0);
  if (total === 0) {
    return <div className="h-1.5 w-full bg-white/[0.06] rounded" />;
  }
  return (
    <div className={`flex w-full overflow-hidden rounded`} style={{ height }}>
      {slices.map((s) => (
        s.value > 0 ? <div key={s.label} title={`${s.label}: ${s.value}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} /> : null
      ))}
    </div>
  );
};

/** Per-step horizontal latency bars. `steps` = [{label, ms, status}]. */
export const StepLatencyBars = ({ steps }) => {
  const max = Math.max(1, ...steps.map((s) => s.ms ?? 0));
  return (
    <div className="space-y-1.5">
      {steps.map((s) => {
        const w = max ? Math.max(2, (s.ms ?? 0) / max * 100) : 0;
        const tone =
          s.status === "failed" ? C.fail
          : s.status === "running" ? C.primary
          : s.status === "ok" ? C.ok
          : C.mute;
        return (
          <div key={s.label} className="grid grid-cols-[140px_minmax(0,1fr)_60px] items-center gap-2 text-[11px]">
            <span className="d-mono text-white/65 truncate">{s.label}</span>
            <div className="h-2 bg-white/[0.04] rounded">
              {s.ms != null && <div className="h-2 rounded" style={{ width: `${w}%`, background: tone }} />}
            </div>
            <span className="d-mono text-white/55 text-right">{s.ms != null ? `${(s.ms / 1000).toFixed(s.ms < 1000 ? 2 : 1)}s` : "—"}</span>
          </div>
        );
      })}
    </div>
  );
};

/** Sparkline over time series with multiple keyed lines. */
export const MultiLineSparkline = ({
  data,
  lines,            // [{ key, color, dashed, label }]
  width = 700,
  height = 120,
  pad = 24,
  xLabel = (d) => d.day?.slice(5) ?? "",
}) => {
  if (!data || data.length === 0) {
    return (
      <div className="text-[12px] text-white/45 px-1 py-3">No activity in this window.</div>
    );
  }
  const max = Math.max(1, ...data.flatMap((d) => lines.map((l) => d[l.key] ?? 0)));
  const step = (width - pad * 2) / Math.max(1, data.length - 1);
  const yScale = (v) => height - pad - (v / max) * (height - pad * 2);
  const path = (key) =>
    data
      .map((d, i) => `${i === 0 ? "M" : "L"}${(pad + i * step).toFixed(1)},${yScale(d[key] ?? 0).toFixed(1)}`)
      .join(" ");
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" className="block">
      <g stroke={C.grid} strokeWidth="1">
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={pad} x2={width - pad} y1={pad + (i / 3) * (height - pad * 2)} y2={pad + (i / 3) * (height - pad * 2)} />
        ))}
      </g>
      {lines.map((l) => (
        <path
          key={l.key}
          d={path(l.key)}
          stroke={l.color}
          strokeWidth={l.width ?? 1.6}
          fill="none"
          strokeDasharray={l.dashed ? "3 4" : undefined}
          opacity={l.opacity ?? 0.9}
        />
      ))}
      <g fontFamily="Chivo Mono, ui-monospace, monospace" fontSize="9" fill={C.text}>
        {data.map((d, i) => (
          <text key={i} x={(pad + i * step).toFixed(1)} y={height - 4} textAnchor="middle">{xLabel(d)}</text>
        ))}
      </g>
      <g fontFamily="Chivo Mono, ui-monospace, monospace" fontSize="9" fill={C.text}>
        <text x={pad - 6} y={pad + 3} textAnchor="end">{max}</text>
        <text x={pad - 6} y={height - pad + 3} textAnchor="end">0</text>
      </g>
    </svg>
  );
};

/** Heat-bar: colored cells representing a sequence of probe statuses. */
export const HealthHeatbar = ({ samples, cellW = 6, cellH = 18, gap = 2 }) => (
  <div className="flex items-center" style={{ gap }}>
    {samples.map((s, i) => {
      const color =
        s === "ok" ? C.ok
        : s === "fail" ? C.fail
        : s === "warn" ? C.warn
        : C.mute;
      return (
        <span
          key={i}
          title={s}
          style={{ width: cellW, height: cellH, background: color, borderRadius: 1, opacity: s === "pending" ? 0.4 : 1 }}
        />
      );
    })}
  </div>
);

export const ChartLegend = ({ items }) => (
  <div className="flex items-center gap-5 text-[11px] d-mono text-white/55 flex-wrap">
    {items.map((it) => (
      <span key={it.label} className="inline-flex items-center gap-1.5">
        <span className="h-[2px] w-3" style={{ background: it.color, borderTop: it.dashed ? `2px dashed ${it.color}` : undefined }} />
        {it.label}
      </span>
    ))}
  </div>
);

export const Colors = C;
