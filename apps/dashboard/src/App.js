import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import "@/App.css";

// Tiny inline icon helper (Flamingo accents)
const Icon = ({ d, size = 12, stroke = "#ED462D", fill = "none", sw = 1.5 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} xmlns="http://www.w3.org/2000/svg">
    <path d={d} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Badge = ({ icon, label }) => (
  <span className="badge">
    <span className="badge-ico">{icon}</span>
    <span className="badge-text">{label}</span>
  </span>
);

// "raft" wordmark — replaces the original RIG logo while preserving the
// caller's `size` + `color` props so layout stays identical.
const RigLogo = ({ size = 22, color = "#0A0A0A" }) => (
  <svg width={size * (88 / 22)} height={size} viewBox="0 0 88 22" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="raft">
    <text
      x="0"
      y="17"
      fontFamily="Chivo Mono, ui-monospace, monospace"
      fontSize="20"
      fontWeight="800"
      fill={color}
      letterSpacing="-0.5"
    >raft</text>
    <rect x="78" y="3" width="6" height="6" fill="#ED462D" />
  </svg>
);

// Decorative low-opacity background mass behind the hero. Five nested
// squares evoke per-PR isolation; the giant "raft" wordmark replaces the
// original RIG glyph.
const HeroBgGlyph = () => (
  <div className="hero-bg-glyph" aria-hidden>
    <svg width="1056" height="1037" viewBox="0 0 1056 1037" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
      <g opacity="0.08">
        {[0, 1, 2, 3, 4].map((i) => {
          const inset = i * 90;
          return (
            <rect
              key={i}
              x={120 + inset}
              y={20 + inset}
              width={Math.max(100, 916 - inset * 2)}
              height={Math.max(100, 916 - inset * 2)}
              fill="none"
              stroke="#0A0A0A"
              strokeWidth="1.6"
            />
          );
        })}
        <text
          x="528"
          y="640"
          textAnchor="middle"
          fontFamily="Chivo Mono, ui-monospace, monospace"
          fontWeight="900"
          fontSize="520"
          letterSpacing="-30"
          fill="#0A0A0A"
        >raft</text>
      </g>
    </svg>
  </div>
);

// Eye / surveillance illustration
const Surveillance = () => (
  <div className="surv">
    <svg viewBox="0 0 380 380" className="surv-svg" xmlns="http://www.w3.org/2000/svg">
      <g opacity="0.35" stroke="#F0EDE6" fill="none" strokeWidth="0.5">
        <circle cx="190" cy="190" r="174" />
        <circle cx="190" cy="190" r="142" />
        <circle cx="190" cy="190" r="110" />
        <circle cx="190" cy="190" r="78" />
        <circle cx="190" cy="190" r="46" />
        <line x1="190" y1="0" x2="190" y2="380" strokeDasharray="4 4" />
        <line x1="0" y1="190" x2="380" y2="190" strokeDasharray="4 4" />
        <line x1="55" y1="55" x2="325" y2="325" strokeDasharray="4 4" />
        <line x1="325" y1="55" x2="55" y2="325" strokeDasharray="4 4" />
      </g>
      {/* corner brackets */}
      {[
        [0, 0], [357, 0], [357, 357], [0, 357]
      ].map(([x, y], i) => (
        <g key={i} stroke="#F0EDE6" strokeWidth="1" fill="none" opacity="0.6">
          <path d={`M${x},${y + 4} L${x},${y} L${x + 4},${y}`} transform={i === 1 ? `translate(${-4 - 4},0) scale(-1,1) translate(-${x * 2},0)` : i === 2 ? `rotate(180 ${x + 12} ${y + 12})` : i === 3 ? `scale(1,-1) translate(0,-${y * 2 + 8})` : ""} />
        </g>
      ))}
      {/* tick marks circle */}
      <g stroke="#F0EDE6" opacity="0.4">
        {Array.from({ length: 60 }).map((_, i) => {
          const a = (i / 60) * Math.PI * 2;
          const r1 = 168;
          const r2 = i % 5 === 0 ? 158 : 163;
          const x1 = 190 + Math.cos(a) * r1;
          const y1 = 190 + Math.sin(a) * r1;
          const x2 = 190 + Math.cos(a) * r2;
          const y2 = 190 + Math.sin(a) * r2;
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} strokeWidth={i % 5 === 0 ? 1 : 0.5} />;
        })}
      </g>
      {/* Eye outline */}
      <g transform="translate(95 134)">
        <path d="M0 56 C 50 0, 140 0, 190 56 C 140 112, 50 112, 0 56 Z" fill="rgba(10,10,10,0.6)" stroke="#F0EDE6" strokeOpacity="0.65" strokeWidth="1.2"/>
        <circle cx="95" cy="56" r="32" fill="#0A0A0A" stroke="#F0EDE6" strokeOpacity="0.6" strokeWidth="1.2"/>
        <circle cx="95" cy="56" r="18" fill="#ED462D"/>
        <circle cx="100" cy="50" r="5" fill="#0A0A0A"/>
        <circle cx="95" cy="56" r="32" fill="none" stroke="#ED462D" strokeOpacity="0.4" strokeWidth="0.5">
          <animate attributeName="r" values="32;36;32" dur="3s" repeatCount="indefinite" />
          <animate attributeName="stroke-opacity" values="0.4;0;0.4" dur="3s" repeatCount="indefinite" />
        </circle>
      </g>
      <text x="170" y="378" fontFamily="Chivo Mono" fontSize="6" fill="#F0EDE6" opacity="0.4" letterSpacing="2">RAFT TELEMETRY</text>
      <text x="364" y="200" fontFamily="Chivo Mono" fontSize="5" fill="#F0EDE6" opacity="0.3" transform="rotate(90 364 200)" letterSpacing="2">PR · ALARM CHAIN</text>
    </svg>
  </div>
);

// Capability illustrations (refined / richer per kind)
const CapIllust = ({ kind }) => {
  const common = { width: "100%", height: "100%", viewBox: "0 0 368 224", fill: "none", xmlns: "http://www.w3.org/2000/svg" };
  if (kind === 1) { // Architecture graph
    const nodes = [
      [60, 60], [60, 110], [60, 160],
      [180, 35], [180, 85], [180, 135], [180, 185],
      [300, 60], [300, 110], [300, 160],
    ];
    const edges = [
      [60,60,180,35],[60,60,180,85],[60,110,180,85],[60,110,180,135],[60,160,180,135],[60,160,180,185],
      [180,35,300,60],[180,85,300,60],[180,85,300,110],[180,135,300,110],[180,135,300,160],[180,185,300,160],
    ];
    return (
      <svg {...common}>
        <defs>
          <pattern id="g1" width="14" height="14" patternUnits="userSpaceOnUse">
            <path d="M 14 0 L 0 0 0 14" stroke="rgba(240,237,230,0.05)" strokeWidth="0.5" fill="none"/>
          </pattern>
        </defs>
        <rect width="368" height="224" fill="url(#g1)"/>
        {edges.map(([x1,y1,x2,y2],i) => (
          <g key={i}>
            <line x1={x1+22} y1={y1} x2={x2-22} y2={y2} stroke="rgba(237,70,45,0.25)" strokeWidth="0.8" />
            <circle r="2" fill="#ED462D" opacity="0.7">
              <animateMotion dur={`${3 + i * 0.18}s`} repeatCount="indefinite" path={`M${x1+22},${y1} L${x2-22},${y2}`} />
            </circle>
          </g>
        ))}
        {nodes.map(([x,y], i) => (
          <g key={i}>
            <rect x={x-22} y={y-9} width="44" height="18" rx="2" fill="rgba(10,10,10,0.92)" stroke={i===0||i===4?"#ED462D":"rgba(240,237,230,0.18)"} strokeOpacity={i===0||i===4 ? 0.85 : 1} strokeWidth="1"/>
            <circle cx={x-15} cy={y} r="1.5" fill={i===0||i===4 ? "#ED462D" : "rgba(240,237,230,0.4)"} />
            <line x1={x-9} y1={y} x2={x+15} y2={y} stroke="rgba(240,237,230,0.18)" strokeWidth="0.6"/>
          </g>
        ))}
      </svg>
    );
  }
  if (kind === 2) { // Context graph - file relationships
    return (
      <svg {...common}>
        <g stroke="rgba(240,237,230,0.08)" fill="none">
          {Array.from({length:8}).map((_,i)=> <line key={i} x1="0" y1={28*i+14} x2="368" y2={28*i+14} />)}
        </g>
        {[
          [60, 60, "env.D1_DB",       true],
          [200, 60, "env.KV",         false],
          [60, 140, "env.QUEUE",      false],
          [200, 140, "env.ChatRoom",  true],
        ].map(([x,y,t,active],i)=>(
          <g key={i}>
            <rect x={x} y={y} width="100" height="40" fill="rgba(10,10,10,0.92)" stroke={active?"#ED462D":"rgba(240,237,230,0.2)"} strokeOpacity={active?0.85:1} rx="2"/>
            <circle cx={x+8} cy={y+8} r="2" fill={active?"#ED462D":"rgba(240,237,230,0.4)"}/>
            <text x={x+18} y={y+12} fontFamily="Chivo Mono" fontSize="7" fill="rgba(240,237,230,0.4)" letterSpacing="0.5">{active ? "● SCOPED" : "○ rewritten"}</text>
            <text x={x+10} y={y+30} fontFamily="Chivo Mono" fontSize="9" fill="rgba(240,237,230,0.75)">{t}</text>
          </g>
        ))}
        <path d="M160 80 Q 180 80 200 80" stroke="#ED462D" strokeOpacity="0.6" strokeWidth="1.2"/>
        <path d="M160 160 Q 180 160 200 160" stroke="#ED462D" strokeOpacity="0.6" strokeWidth="1.2"/>
        <path d="M110 100 L 110 140" stroke="rgba(240,237,230,0.25)" strokeDasharray="2 2"/>
        <path d="M250 100 L 250 140" stroke="rgba(240,237,230,0.25)" strokeDasharray="2 2"/>
      </svg>
    );
  }
  if (kind === 3) { // Strategize - Explore Plan Execute
    return (
      <svg {...common}>
        <g stroke="rgba(240,237,230,0.08)" fill="none">
          {Array.from({length:14}).map((_,i)=> <line key={i} x1={26*i} y1="0" x2={26*i} y2="224" />)}
        </g>
        {["PROVISION","UPLOAD","ROUTE"].map((t,i)=>(
          <g key={i}>
            <rect x={30 + i*110} y="92" width="90" height="40" fill={i===1?"rgba(237,70,45,0.14)":"rgba(10,10,10,0.92)"} stroke={i===1?"#ED462D":"rgba(240,237,230,0.22)"} strokeWidth={i===1?1.2:1} rx="2"/>
            <text x={75 + i*110} y="116" textAnchor="middle" fontFamily="Chivo Mono" fontWeight="700" fontSize="10" fill={i===1?"#ED462D":"rgba(240,237,230,0.7)"} letterSpacing="2">{t}</text>
            {i<2 && (
              <g>
                <line x1={120+i*110} y1={112} x2={140+i*110} y2={112} stroke="#ED462D" strokeOpacity="0.6" strokeWidth="1.2"/>
                <polygon points={`${140+i*110},112 ${134+i*110},109 ${134+i*110},115`} fill="#ED462D" opacity="0.8"/>
              </g>
            )}
            <text x={75 + i*110} y="76" textAnchor="middle" fontFamily="Chivo Mono" fontSize="7" fill="rgba(240,237,230,0.3)" letterSpacing="1.5">[ {String(i+1).padStart(2,'0')} ]</text>
          </g>
        ))}
        <text x="184" y="180" textAnchor="middle" fontFamily="Chivo Mono" fontSize="8" fill="rgba(240,237,230,0.35)" letterSpacing="2">ALARM-DRIVEN STEP MACHINE</text>
      </svg>
    );
  }
  if (kind === 4) { // Tool calls / agent log
    return (
      <svg {...common}>
        <g stroke="rgba(240,237,230,0.06)">
          {Array.from({length:11}).map((_,i)=> <line key={i} x1="0" y1={20*i+12} x2="368" y2={20*i+12} />)}
        </g>
        {[
          { t: "→ webhook_accepted  pull_request", c: "rgba(240,237,230,0.55)", y: 30 },
          { t: "✓ step_ok  provision-resources", c: "#22C55E", y: 60 },
          { t: "↺ propagation_retry  attempt:1", c: "rgba(234,179,8,0.85)", y: 90 },
          { t: "✓ step_ok  upload-script  200", c: "#22C55E", y: 120 },
          { t: "✓ provision.succeeded · 6.1s", c: "#ED462D", y: 150 },
        ].map((row, i) => (
          <text key={i} x="20" y={row.y} fontFamily="Chivo Mono" fontWeight={i===4?"700":"400"} fontSize="10" fill={row.c}>{row.t}</text>
        ))}
        <rect x="220" y="36" width="120" height="124" stroke="rgba(237,70,45,0.45)" fill="rgba(237,70,45,0.04)" rx="2"/>
        <line x1="220" y1="58" x2="340" y2="58" stroke="rgba(237,70,45,0.25)"/>
        <text x="226" y="52" fontFamily="Chivo Mono" fontWeight="700" fontSize="8" fill="#ED462D" letterSpacing="2">RUNNER</text>
        <text x="280" y="100" textAnchor="middle" fontFamily="Chivo Mono" fontSize="8" fill="rgba(240,237,230,0.45)" letterSpacing="1">alarm-driven DO</text>
        {Array.from({length:4}).map((_,i)=>(
          <rect key={i} x={232} y={114 + i*10} width={Math.max(20, 90 - i*16)} height="3" fill="rgba(237,70,45,0.55)" opacity={1 - i*0.2}/>
        ))}
      </svg>
    );
  }
  if (kind === 5) { // Sandboxes
    return (
      <svg {...common}>
        {[0,1,2].map(i => (
          <g key={i} transform={`translate(${30+i*120} ${50})`}>
            <rect width="100" height="124" fill="rgba(10,10,10,0.92)" stroke={i===1?"#ED462D":"rgba(240,237,230,0.2)"} strokeOpacity={i===1?0.85:1} rx="2"/>
            <rect x="6" y="6" width="88" height="14" fill="rgba(240,237,230,0.04)"/>
            <circle cx="12" cy="13" r="2.4" fill={i===1 ? "#ED462D" : "rgba(240,237,230,0.3)"}>
              {i===1 && <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite"/>}
            </circle>
            <text x="20" y="16" fontFamily="Chivo Mono" fontWeight="700" fontSize="6" fill="rgba(240,237,230,0.55)" letterSpacing="1.2">PR·{String(i+1).padStart(2,'0')}</text>
            {Array.from({length:6}).map((_,j)=>(
              <line key={j} x1="10" y1={36+j*12} x2={Math.max(20, 80-j*8)} y2={36+j*12} stroke={j===i?"#ED462D":"rgba(240,237,230,0.2)"} strokeOpacity={j===i?0.6:1} strokeWidth="0.6"/>
            ))}
            <text x="50" y="116" textAnchor="middle" fontFamily="Chivo Mono" fontSize="6" fill="rgba(240,237,230,0.3)" letterSpacing="1">{i===1 ? "READY" : i===0 ? "torn down" : "provisioning"}</text>
          </g>
        ))}
        <text x="184" y="200" textAnchor="middle" fontFamily="Chivo Mono" fontSize="8" fill="rgba(240,237,230,0.32)" letterSpacing="2">ISOLATED · PER-PR · DISPOSABLE</text>
      </svg>
    );
  }
  // 6 - test count + provision-time bars
  return (
    <svg {...common}>
      <g stroke="rgba(240,237,230,0.06)">
        {Array.from({length:11}).map((_,i)=> <line key={i} x1="0" y1={20*i+12} x2="368" y2={20*i+12} />)}
      </g>
      <text x="184" y="98" textAnchor="middle" fontFamily="YD Yoonche, Inter" fontWeight="700" fontSize="56" fill="#F0EDE6" letterSpacing="-2">86</text>
      <text x="184" y="124" textAnchor="middle" fontFamily="Chivo Mono" fontWeight="700" fontSize="10" fill="#ED462D" letterSpacing="3">TESTS · ALL GREEN</text>
      <g>
        <line x1="60" y1="170" x2="308" y2="170" stroke="rgba(240,237,230,0.18)" strokeWidth="1"/>
        {Array.from({length:30}).map((_,i)=>{
          const h = Math.max(4, Math.abs(Math.sin(i*0.7)*22 + Math.cos(i*1.1)*8) + 6);
          const x = 60+i*8.5;
          return <line key={i} x1={x} y1={170} x2={x} y2={170-h} stroke="#ED462D" strokeOpacity={0.4 + (i%5)*0.12} strokeWidth="2.4"/>;
        })}
      </g>
      <text x="60" y="195" fontFamily="Chivo Mono" fontSize="7" fill="rgba(240,237,230,0.35)" letterSpacing="1.5">vitest-pool-workers</text>
      <text x="308" y="195" textAnchor="end" fontFamily="Chivo Mono" fontSize="7" fill="rgba(240,237,230,0.35)" letterSpacing="1.5">23 FILES · 86 TESTS</text>
    </svg>
  );
};

// Globe outline (offline section)
const Globe = () => (
  <svg viewBox="0 0 900 900" width="100%" height="100%" className="globe-svg">
    <g stroke="rgba(240,237,230,0.06)" fill="none" strokeWidth="1">
      <circle cx="450" cy="450" r="395" />
      <ellipse cx="450" cy="450" rx="395" ry="120" />
      <ellipse cx="450" cy="450" rx="395" ry="220" />
      <ellipse cx="450" cy="450" rx="395" ry="320" />
      <ellipse cx="450" cy="450" rx="120" ry="395" />
      <ellipse cx="450" cy="450" rx="220" ry="395" />
      <ellipse cx="450" cy="450" rx="320" ry="395" />
      <line x1="55" y1="450" x2="845" y2="450" />
      <line x1="450" y1="55" x2="450" y2="845" />
    </g>
    {/* dots */}
    {Array.from({length: 80}).map((_,i)=>{
      const phi = Math.acos(2*((i+0.5)/80)-1);
      const theta = Math.PI*(1+Math.sqrt(5))*i;
      const r = 395;
      const x = 450 + r*Math.cos(theta)*Math.sin(phi);
      const y = 450 + r*Math.cos(phi);
      const z = Math.sin(theta)*Math.sin(phi);
      return z>-0.2 ? <circle key={i} cx={x} cy={y} r={1.5} fill="rgba(240,237,230,0.2)" /> : null;
    })}
  </svg>
);

// Network diagram for "Introducing Raft": GitHub PR → raft-control → CF
// resources → live preview. Replaces the generic Rig template diagram.
const NetworkDiagram = () => (
  <svg viewBox="0 0 1000 580" width="100%" className="net-svg">
    {/* GITHUB box at top */}
    <rect x="400" y="40" width="200" height="50" fill="rgba(10,10,10,0.6)" stroke="rgba(240,237,230,0.18)" strokeWidth="1" strokeDasharray="5 5"/>
    <text x="500" y="71" textAnchor="middle" fontFamily="Chivo Mono" fontSize="13" fill="rgba(240,237,230,0.5)" letterSpacing="3">GITHUB</text>
    {/* solid green webhook line into raft-control */}
    <line x1="500" y1="90" x2="500" y2="208" stroke="rgba(34,197,94,0.45)" strokeWidth="1" strokeDasharray="3 4"/>
    <text x="510" y="142" fontFamily="Chivo Mono" fontSize="9" fill="rgba(34,197,94,0.7)" letterSpacing="1.5">pull_request webhook</text>
    <text x="510" y="156" fontFamily="Chivo Mono" fontSize="9" fill="rgba(34,197,94,0.5)" letterSpacing="1.5">HMAC-verified</text>

    {/* CLOUDFLARE FREE TIER wrapping container */}
    <rect x="40" y="210" width="920" height="200" fill="none" stroke="rgba(240,237,230,0.18)" strokeWidth="1" strokeDasharray="5 5"/>
    <text x="60" y="202" fontFamily="Chivo Mono" fontSize="11" fill="rgba(240,237,230,0.4)" letterSpacing="2">CLOUDFLARE · FREE TIER</text>

    {/* PR EVENT (in queue) */}
    <rect x="70" y="260" width="220" height="100" fill="rgba(10,10,10,0.6)" stroke="rgba(240,237,230,0.22)" strokeWidth="1"/>
    <text x="180" y="304" textAnchor="middle" fontFamily="Inter" fontWeight="500" fontSize="14" fill="rgba(240,237,230,0.6)">raft-events queue</text>
    <text x="180" y="326" textAnchor="middle" fontFamily="Chivo Mono" fontSize="10" fill="rgba(240,237,230,0.32)" letterSpacing="2">DECOUPLED · &lt;200ms ACK</text>

    {/* dashed green connector → RAFT-CONTROL */}
    <line x1="295" y1="310" x2="370" y2="310" stroke="rgba(34,197,94,0.45)" strokeWidth="1" strokeDasharray="3 3"/>
    <rect x="376" y="307" width="6" height="6" fill="#22C55E" opacity="0.85"/>

    {/* RAFT-CONTROL box */}
    <rect x="385" y="232" width="230" height="156" fill="rgba(10,10,10,0.85)" stroke="rgba(240,237,230,0.32)" strokeWidth="1"/>
    <text x="500" y="270" textAnchor="middle" fontFamily="Chivo Mono" fontWeight="700" fontSize="20" fill="#F0EDE6" letterSpacing="3">raft-control</text>
    <text x="500" y="296" textAnchor="middle" fontFamily="Chivo Mono" fontSize="10" fill="#ED462D" letterSpacing="2">● 5-STEP ALARM RUNNER</text>
    <line x1="402" y1="335" x2="598" y2="335" stroke="rgba(240,237,230,0.10)"/>
    <text x="425" y="370" textAnchor="middle" fontFamily="Chivo Mono" fontSize="10" fill="rgba(240,237,230,0.35)" letterSpacing="1.5">DOs</text>
    <text x="500" y="370" textAnchor="middle" fontFamily="Chivo Mono" fontSize="10" fill="rgba(240,237,230,0.35)" letterSpacing="1.5">D1</text>
    <text x="575" y="370" textAnchor="middle" fontFamily="Chivo Mono" fontSize="10" fill="rgba(240,237,230,0.35)" letterSpacing="1.5">KV+Q</text>

    {/* dashed green connector → LIVE PREVIEW */}
    <line x1="618" y1="310" x2="700" y2="310" stroke="rgba(34,197,94,0.45)" strokeWidth="1" strokeDasharray="3 3"/>
    <rect x="704" y="307" width="6" height="6" fill="#22C55E" opacity="0.85"/>

    {/* LIVE PREVIEW */}
    <rect x="715" y="260" width="210" height="100" fill="rgba(10,10,10,0.6)" stroke="rgba(240,237,230,0.22)" strokeWidth="1"/>
    <text x="820" y="304" textAnchor="middle" fontFamily="Inter" fontWeight="500" fontSize="14" fill="rgba(240,237,230,0.6)">live preview</text>
    <text x="820" y="326" textAnchor="middle" fontFamily="Chivo Mono" fontSize="10" fill="#22C55E" letterSpacing="2">~6s · *.workers.dev</text>

    {/* TEARDOWN below */}
    <line x1="500" y1="410" x2="500" y2="510" stroke="rgba(34,197,94,0.45)" strokeDasharray="3 4"/>
    <text x="510" y="450" fontFamily="Chivo Mono" fontSize="9" fill="rgba(34,197,94,0.7)" letterSpacing="1.5">on PR close</text>
    <text x="510" y="464" fontFamily="Chivo Mono" fontSize="9" fill="rgba(34,197,94,0.5)" letterSpacing="1.5">9-step destruction</text>
    <rect x="400" y="510" width="200" height="50" fill="rgba(10,10,10,0.6)" stroke="rgba(240,237,230,0.18)" strokeWidth="1" strokeDasharray="5 5"/>
    <text x="500" y="541" textAnchor="middle" fontFamily="Chivo Mono" fontSize="13" fill="rgba(240,237,230,0.5)" letterSpacing="3">TORN DOWN</text>
  </svg>
);

// Animated horizontal red bars used as the "shader" in Intro & Early Access sections
const ShaderBars = ({ count = 26 }) => {
  // deterministic pseudo-random based on index so it's stable across renders
  const rand = (i, k) => {
    const v = Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  return (
    <div className="shader-bars" aria-hidden>
      {Array.from({ length: count }).map((_, i) => {
        const top = (i / count) * 100 + (rand(i, 1) - 0.5) * 6;
        const w = 60 + rand(i, 2) * 240;
        const startLeft = -100 + rand(i, 3) * 80;
        const dur = 6 + rand(i, 4) * 10;
        const delay = -rand(i, 5) * dur;
        const opacity = 0.55 + rand(i, 6) * 0.45;
        const h = 6 + rand(i, 7) * 10;
        return (
          <span
            key={i}
            className="shader-bar"
            style={{
              top: `${top}%`,
              width: `${w}px`,
              height: `${h}px`,
              left: `${startLeft}%`,
              opacity,
              animationDuration: `${dur}s`,
              animationDelay: `${delay}s`,
            }}
          />
        );
      })}
    </div>
  );
};
const FAQS = [
  { q: "What is Raft?", a: "Raft is a GitHub App that provisions an isolated D1 database, KV namespace, Queue, and Worker for every pull request — and tears them all down when the PR closes. It runs entirely on Cloudflare's free tier with $0 lingering cost per PR." },
  { q: "How does it isolate per-PR resources?", a: "On pull_request.opened, the webhook is HMAC-verified, queued, and a Durable Object orchestrator alarm-drives a 5-step provisioning machine: load-config, provision-resources, rewrite-bundle, upload-script, route-and-comment. Each PR gets its own freshly-named D1 database, KV namespace, Queue, and uploaded Worker." },
  { q: "Why Durable Object Alarms instead of Workflows?", a: "Cloudflare Workflows is paid-tier. Raft replicates Workflows' semantics — durable retryable steps, idempotency keyed by step name, exponential backoff, NonRetryableError short-circuit — in ~200 lines of DO + alarm code. Same step interface, swappable to Workflows by deleting the runner shell." },
  { q: "What's the free-tier ceiling?", a: "Cloudflare Workers Free caps at 100 scripts per account, so Raft supports ~95 concurrent PR previews. D1 is 10 databases free. KV/Queues have generous free quotas. Production deployments would move to Workers Paid + R2 + Workflows; the substitution layer is designed to make that swap mechanical." },
  { q: "How long does provisioning take?", a: "Verified at ~6 seconds end-to-end on a real PR: webhook → queue → DO → 5 alarm-driven CF API calls → ROUTES KV write → preview URL live. Teardown on PR close runs 9 destruction steps and is idempotent on replay." },
  { q: "What happens if a step fails mid-provision?", a: "The runner backs off (1s/2s/4s/8s/16s, max 5 attempts). Specific CF binding-not-found errors (10181, 10041, 100100) trigger an in-step propagation retry separate from the runner backoff. NonRetryableError short-circuits to compensating teardown. A closed-PR guard at the top of each alarm tick prevents racing against deleted resources." },
  { q: "Where do live PR logs come from?", a: "v1 free-tier omits Tail Workers (Workers Paid only). The LogTail DO uses hibernatable WebSockets to fan out events to dashboard tabs — production wiring would bind raft-tail as a Tail consumer; v2 path documented in the README." },
  { q: "Where's the source?", a: "github.com/Adi-gitX/Rift. PRD, day-by-day amendments, integration tests, and the bootstrap script are all in the repo." },
];

const ProblemCard = ({ tag, num, title, desc, borderRight = true, borderBottom = true }) => (
  <div className={`problem-card ${borderRight ? "br" : ""} ${borderBottom ? "bb" : ""}`}>
    <div className="prob-head">
      <span className="prob-tag">{tag}</span>
      <span className="prob-num">{num}</span>
    </div>
    <h3 className="prob-title">{title}</h3>
    <p className="prob-desc">{desc}</p>
  </div>
);

const CapabilityCard = ({ idx, title, desc, kind }) => (
  <div className="cap-card">
    <div className="cap-illust"><CapIllust kind={kind} /></div>
    <div className="cap-body">
      <span className="cap-num">[ 0{idx} ]</span>
      <h3 className="cap-title">{title}</h3>
      <p className="cap-desc">{desc}</p>
    </div>
  </div>
);

const FaqItem = ({ q, a, num, open, onClick }) => (
  <div className={`faq-item ${open ? "open" : ""}`}>
    <button className="faq-row" onClick={onClick} data-testid={`faq-toggle-${num}`}>
      <span className="faq-num">{num}</span>
      <span className="faq-q">{q}</span>
      <span className="faq-chev" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </span>
    </button>
    <div className="faq-a-wrap">
      <p className="faq-a">{a}</p>
    </div>
  </div>
);

const Stepper = () => {
  const [active, setActive] = useState(0);
  const steps = [
    {
      n: "Step 01", title: "Install the GitHub App.\nDrop in a .raft.json.",
      body: [
        "One-click GitHub App install on the repos you want previews for. The customer-side `raft-bundle.yml` GitHub Action ships with the app — it builds the worker bundle and POSTs it to Raft on every PR.",
        "The .raft.json declares which bindings (D1, KV, Queue, R2, DOs) Raft should isolate per PR. Sane defaults — most projects don't need to touch it.",
      ],
      card: {
        title: "Install footprint",
        rows: [
          { label: "Setup time", a: { name: "Raft", val: 92 }, b: { name: "Manual per-PR", val: 12 } },
          { label: "Customer code changes", a: { name: "Raft", val: 96 }, b: { name: "Manual per-PR", val: 18 } },
        ],
      },
    },
    {
      n: "Step 02", title: "Open a PR.\nWebhook fires, queue picks it up.",
      body: [
        "GitHub posts pull_request.opened to /webhooks/github. Raft HMAC-verifies, parses the event with Zod, and enqueues a typed message into the raft-events queue. The webhook handler returns 202 in under 200ms.",
        "The queue consumer dispatches into a per-(installation, repo) RepoCoordinator Durable Object — single-writer for that PR's state machine — which then starts the ProvisionRunner DO.",
      ],
      card: {
        title: "Webhook → DO",
        rows: [
          { label: "Webhook ack", a: { name: "Raft", val: 98 }, b: { name: "Typical CI", val: 35 } },
          { label: "State-machine isolation", a: { name: "Raft", val: 100 }, b: { name: "Typical CI", val: 22 } },
        ],
      },
    },
    {
      n: "Step 03", title: "Alarm-driven runner spins\nup the per-PR resources.",
      body: [
        "The ProvisionRunner DO walks 5 alarm-driven steps: load-config, provision-resources (D1 + KV + Queue in parallel), rewrite-bundle (DO wrapper codegen), upload-script (PUT /workers/scripts/{name}), route-and-comment.",
        "Each step's result is cached by name in DO storage — re-entry after a crash reuses cached results, never double-calls the CF API. Within ~6 seconds, a fresh per-PR Worker is live at *.workers.dev.",
      ],
      card: {
        title: "Provisioning chain",
        rows: [
          { label: "Step idempotency", a: { name: "Raft", val: 100 }, b: { name: "Hand-rolled", val: 30 } },
          { label: "Time to ready", a: { name: "Raft", val: 94 }, b: { name: "Hand-rolled", val: 28 } },
        ],
      },
    },
    {
      n: "Step 04", title: "Close the PR.\nEverything cleanly deleted.",
      body: [
        "On pull_request.closed, the TeardownRunner DO walks 9 steps: delete the worker script, delete the D1 fork, delete the KV namespace, delete the queue (by UUID), purge the bundle KV, evict DO shards (PRD amendment A1), clear the route entry. CF 404s are treated as already-deleted (idempotent).",
        "A nightly cron at 04:00 UTC sweeps any envs idle for 7+ days. $0 lingering cost.",
      ],
      card: {
        title: "Teardown chain",
        rows: [
          { label: "Steps idempotent on replay", a: { name: "Raft", val: 100 }, b: { name: "Manual cleanup", val: 14 } },
          { label: "Resources freed per PR", a: { name: "Raft", val: 100 }, b: { name: "Manual cleanup", val: 40 } },
        ],
      },
    },
  ];
  return (
    <div className="how-stepper" data-testid="stepper">
      <div className="how-steps">
        {steps.map((s, i) => (
          <div
            key={i}
            className={`how-step ${active === i ? "active" : ""}`}
            onMouseEnter={() => setActive(i)}
            onClick={() => setActive(i)}
          >
            <div className="how-step-row">
              <span className="how-step-num">{s.n}</span>
              <h3 className="how-step-title">{s.title}</h3>
            </div>
            {active === i && (
              <div className="how-step-body">
                {s.body.map((t, j) => <p key={j}>{t}</p>)}
              </div>
            )}
            <span className="how-step-progress" />
          </div>
        ))}
      </div>
      <div className="how-illust">
        <div className="how-bg" style={{ backgroundImage: "url(/figma-assets/how-it-works.png)" }} />
        <div className="how-card">
          <div className="how-card-title">{steps[active].card.title}</div>
          <div className="how-card-rows">
            {steps[active].card.rows.map((row, i) => (
              <div key={i} className="hcr">
                <div className="hcr-label">{row.label}</div>
                <div className="hcr-bar primary">
                  <span className="hcr-name">{row.a.name}</span>
                  <span className="hcr-track"><span className="hcr-fill primary" style={{ width: `${row.a.val}%` }} /></span>
                  <span className="hcr-val">{row.a.val}%</span>
                </div>
                <div className="hcr-bar muted">
                  <span className="hcr-name">{row.b.name}</span>
                  <span className="hcr-track"><span className="hcr-fill muted" style={{ width: `${row.b.val}%` }} /></span>
                  <span className="hcr-val">{row.b.val}%</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// Vent decoration for monitor
const Vents = () => (
  <div className="vents">
    {Array.from({ length: 36 }).map((_, i) => <span key={i} />)}
  </div>
);

// Annotation lines for terminal
const BPLine = ({ side = "left", title, desc, top }) => (
  <div className={`bp-anno bp-${side}`} style={{ top }}>
    {side === "right" && <span className="bp-dot" />}
    {side === "right" && <span className="bp-line" />}
    <div className="bp-text">
      <span className="bp-title">{title}</span>
      <span className="bp-desc">{desc}</span>
    </div>
    {side === "left" && <span className="bp-line" />}
    {side === "left" && <span className="bp-dot" />}
  </div>
);

const Terminal = () => (
  <div className="monitor-casing">
    <Vents />
    <div className="monitor-screen">
      <div className="term-bar">
        <span className="term-dots"><i/><i/><i/></span>
        <span className="term-title">wrangler tail raft-control · live</span>
        <span className="term-blink" />
      </div>
      <div className="term-body">
        <div className="term-line"><span className="t-prompt">λ</span> <span className="t-cmd">wrangler tail raft-control --format pretty</span></div>
        <pre className="term-ascii">{`  ██████╗   █████╗  ███████╗ ████████╗
  ██╔══██╗ ██╔══██╗ ██╔════╝ ╚══██╔══╝
  ██████╔╝ ███████║ █████╗      ██║
  ██╔══██╗ ██╔══██║ ██╔══╝      ██║
  ██║  ██║ ██║  ██║ ██║         ██║
  ╚═╝  ╚═╝ ╚═╝  ╚═╝ ╚═╝         ╚═╝`}</pre>
        <div className="term-line dim">{"> webhook_accepted  event=pull_request  delivery=…"}</div>
        <div className="term-line dim">{"> step_ok  load-config"}</div>
        <div className="term-line dim">{"> step_ok  provision-resources  d1=09b44cb7  kv=ae5c9058  q=b0393782"}</div>
        <div className="term-line"><span className="dim">{"> step_ok  upload-script  script=raft-128067035-…-pr-7  "}</span><span className="ok">200</span></div>
        <div className="term-line dim">{"> step_ok  route-and-comment  hostname=raft-dispatcher.…/pr-7--demot"}</div>
        <div className="term-line ready"><span className="ok">✓</span> provision.succeeded · <span className="muted">elapsed: <b className="ok">6.1s</b></span></div>
        <div className="term-line"><span className="t-prompt">λ</span> <span className="cursor" /></div>
      </div>
    </div>
    <div className="monitor-footer">
      <span>raft-control</span>
      <span className="led" />
      <span className="model-tag">v3</span>
      <span>cloudflare-native</span>
    </div>
  </div>
);

const tickerItems = [
  "Per-PR D1 fork", "•", "Per-PR KV namespace", "•", "Per-PR Queue", "•",
  "Per-PR Worker", "•", "6-second provision", "•",
  "9-step alarm-driven teardown", "•", "$0 per PR", "•",
];

function App() {
  const navigate = useNavigate();
  const [openFaq, setOpenFaq] = useState(0);
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [statsVisible, setStatsVisible] = useState(false);

  // Custom cursor / parallax tracker
  useEffect(() => {
    const root = document.documentElement;
    const onMove = (e) => {
      root.style.setProperty("--mx", `${e.clientX}px`);
      root.style.setProperty("--my", `${e.clientY}px`);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  // Reveal on scroll
  useEffect(() => {
    const els = document.querySelectorAll("[data-reveal]");
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add("revealed");
        });
      },
      { threshold: 0.12 }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  // Count-up trigger when stats enter viewport
  useEffect(() => {
    const stats = document.querySelector(".stats-strip");
    if (!stats) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setStatsVisible(true);
        });
      },
      { threshold: 0.4 }
    );
    io.observe(stats);
    return () => io.disconnect();
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!email) return;
    setSubmitted(true);
    setTimeout(() => {
      setSubmitted(false);
      navigate("/dashboard");
    }, 700);
    setEmail("");
  };

  return (
    <div className="rig-root">
      {/* Inline SVG filters: #grainy (animated film grain) + #bloom (glow) */}
      <svg width="0" height="0" style={{ position: "absolute", display: "none" }} aria-hidden>
        <defs>
          <filter id="grainy" x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.4" numOctaves="4" stitchTiles="stitch" seed="0">
              <animate attributeName="seed" from="0" to="100" dur="10s" repeatCount="indefinite" />
            </feTurbulence>
            <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1 0 0 0 0" />
          </filter>
          <filter id="bloom" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="10" result="glow-wide" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="glow-tight" />
            <feComposite in="SourceGraphic" in2="glow-wide" operator="arithmetic" k1="0" k2="1" k3="0.5" k4="0" result="with-wide" />
            <feComposite in="with-wide" in2="glow-tight" operator="arithmetic" k1="0" k2="1" k3="0.3" k4="0" />
          </filter>
        </defs>
      </svg>

      {/* HERO */}
      <section className="hero">
        {/* Grain noise overlay (top-of-stack texture) */}
        <svg className="hero-grain" aria-hidden xmlns="http://www.w3.org/2000/svg">
          <filter id="grain-filter">
            <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
            <feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.55 0"/>
          </filter>
          <rect width="100%" height="100%" filter="url(#grain-filter)"/>
        </svg>
        {/* Subtle vertical fade for depth */}
        <div className="hero-vignette" aria-hidden />

        <header className="site-header">
          <div className="nav">
            <a href="/" className="brand-link" aria-label="Raft home"><RigLogo size={22} color="#0A0A0A" /></a>
            <ul className="nav-menu">
              <li><a href="https://github.com/Adi-gitX/Rift" className="nav-link" target="_blank" rel="noreferrer">Source</a></li>
              <li>
                <a href="/dashboard" onClick={(e) => { e.preventDefault(); navigate("/dashboard"); }} className="btn btn-chamfer btn-dark" data-testid="nav-cta">Open dashboard</a>
              </li>
            </ul>
          </div>
        </header>

        <HeroBgGlyph />

        <div className="hero-content">
          <h1 className="hero-h1" data-reveal>
            Every PR gets its<br/>
            own Cloudflare.
          </h1>
          <p className="hero-sub" data-reveal>
            Raft is a GitHub App that provisions an isolated D1 database, KV namespace, Queue, and<br/>
            Worker for every pull request — and tears it all down when the PR closes. Built on Cloudflare's free tier.
          </p>
          <div className="hero-actions" data-reveal>
            <a href="https://github.com/apps/rift-aditya" className="btn btn-chamfer btn-dark btn-lg" data-testid="hero-cta-primary" target="_blank" rel="noreferrer">Install on GitHub</a>
            <a href="https://github.com/Adi-gitX/Rift" className="btn btn-chamfer btn-outline btn-lg" data-testid="hero-cta-secondary" target="_blank" rel="noreferrer">View source</a>
          </div>
        </div>

        <div className="ticker">
          <div className="ticker-track">
            {[...Array(3)].map((_, k) => (
              <div className="ticker-group" key={k}>
                {tickerItems.map((t, i) => (
                  <span key={i} className={t === "•" ? "tdot" : "titem"}>{t}</span>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Hero-only CRT effects removed — global .noise + .scanlines + .rgb-fringe handle this site-wide */}
      </section>

      {/* PROBLEM */}
      <div className="frame-col">
      <section className="section problem">
        <div className="container">
          <div className="problem-frame">
            <div className="prob-top">
              <Badge icon={<Icon d="M3 3 L13 13 M13 3 L3 13" />} label="The problem" />
              <h2 className="prob-headline" data-reveal>Per-PR previews are<br/>painful to ship right.</h2>
            </div>
            <div className="prob-grid">
              <div className="prob-illust"><Surveillance /></div>
              <div className="prob-cell-grid">
                <ProblemCard tag="Shared state" num="001" title="One staging DB for every PR." desc="Tests collide. Migrations leak between branches. Reviewers can't tell whose data is whose. The cost of getting isolation right is usually higher than the value of having previews at all." />
                <ProblemCard tag="Manual cleanup" num="002" title="Resources outlive the PR." desc="Branch closes; the orphan DB, queue, and Worker stick around. A month later you're paying for 200 stale environments and nobody knows which are safe to delete." borderRight={false} />
                <ProblemCard tag="Paid-tier lock-in" num="003" title="Workers for Platforms costs $25/mo before line one." desc="So does Workflows. If you want a credible per-PR system on Cloudflare today, the bill arrives before the demo does." borderBottom={false} />
                <ProblemCard tag="Race conditions" num="004" title="Provision and teardown collide." desc="Open and close a PR fast enough and you'll race CF's eventually-consistent APIs against each other. Without idempotent step machines you leak resources or 500 the customer." borderRight={false} borderBottom={false} />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* INTRODUCING RAFT */}
      <section className="section intro-rig" id="introducing-rig">
        <ShaderBars count={28} />
        <div className="container intro-rig-inner" data-reveal>
          <Badge icon={<Icon d="M3 8a5 5 0 1 1 10 0a5 5 0 1 1 -10 0z" />} label="Introducing Raft" />
          <h2 className="display center">One GitHub App.<br/>Five Cloudflare primitives.</h2>
          <p className="lead center">Three Workers, five Durable Object classes, one D1 control plane.<br/>raft-control runs the API + dashboard + cron + queue consumer + every DO.</p>
          <div className="net-wrap"><NetworkDiagram /></div>
        </div>
      </section>

      {/* PROVENANCE / LIVE PROOF */}
      <section className="section offline">
        <div className="container offline-grid">
          <div className="offline-text" data-reveal>
            <Badge icon={<Icon d="M2 8h12 M8 2v12" />} label="Live proof" />
            <h2 className="display">Verified on PR #7.</h2>
            <p className="lead">Real Cloudflare resources spawned and<br/>deleted. 6-second provision. Full teardown on close.</p>
          </div>
          <div className="offline-visual" data-reveal>
            <div className="globe-wrap"><Globe /></div>
            <div className="offline-flow">
              <div className="of-card muted">D1 · 09b44cb7-95f2-403f-b6d7-934b62bde602</div>
              <div className="of-sever"><span className="of-line" /><span className="of-tag">FORKED</span><span className="of-line" /></div>
              <div className="of-card primary">
                <span>Worker · raft-128067035-adigitxraftdemot-pr-7</span>
                <span className="of-ok"><i>✓</i> live at *.workers.dev</span>
              </div>
              <div className="of-sever"><span className="of-line" /><span className="of-tag">ROUTED</span><span className="of-line" /></div>
              <div className="of-card muted">KV · ae5c905877e24748a359c377755906af</div>
              <div className="of-sever"><span className="of-line" /><span className="of-tag">ISOLATED</span><span className="of-line" /></div>
              <div className="of-card muted">Queue · b0393782555b40e29af49cb21954830c</div>
            </div>
          </div>
        </div>
      </section>

      {/* THREE COLS */}
      <section className="section three-col">
        <div className="container three-col-grid">
          {[
            { label: "Free tier", title: "$0 per PR", text: "Workers for Platforms ($25/mo) → direct uploads. Workflows (paid) → DO Alarms. R2 → KV. Five substitutions, one credit-card-free deployment.", icon: <Icon d="M2 8h12 M11 5l3 3-3 3" /> },
            { label: "Isolation", title: "Per-PR everything", text: "Forked D1 database, dedicated KV namespace, dedicated Queue, freshly-uploaded Worker. The wrapper rewriter scopes DO instance names to pr-N--repo so shards never collide.", icon: <Icon d="M4 7v-2a4 4 0 1 1 8 0v2 M3 7h10v6H3z" /> },
            { label: "Lifecycle", title: "Cleanly torn down", text: "Close the PR; nine alarm-driven destruction steps run. Every step is idempotent — replay is safe. A nightly cron sweeps anything still alive past 7 days.", icon: <Icon d="M8 2v6l4 2" fill="none" /> },
          ].map((c, i) => (
            <React.Fragment key={i}>
              <div className="three-col-cell" data-reveal>
                <Badge icon={c.icon} label={c.label} />
                <h3 className="display sm center">{c.title}</h3>
                <p className="lead center">{c.text}</p>
              </div>
              {i < 2 && <div className="three-col-divider" />}
            </React.Fragment>
          ))}
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="section how" id="approach">
        <div className="container">
          <div className="how-head" data-reveal>
            <Badge icon={<Icon d="M3 13l5-10 5 10z" />} label="How it works" />
            <h2 className="display center">Webhook to live preview in 6 seconds.</h2>
            <p className="lead center max-620">Each PR walks the same alarm-driven step machine. Every step is idempotent.<br/>Every failure mode has a documented retry or compensating teardown.</p>
          </div>
          <Stepper />
        </div>
      </section>

      {/* CAPABILITIES */}
      <section className="section capabilities" id="capabilities">
        <div className="container">
          <div className="cap-head" data-reveal>
            <Badge icon={<Icon d="M4 8l3 3 5-6" />} label="Engineering" />
            <h2 className="display center">Built like infrastructure, not a side project.</h2>
          </div>
          <div className="cap-grid">
            {[
              { t: "Three Workers, five Durable Objects.", d: "raft-control (webhooks + API + dashboard + cron + queue + every DO), raft-dispatcher (path-based proxy), raft-tail (Tail consumer). DOs: RepoCoordinator, PrEnvironment, ProvisionRunner, TeardownRunner, LogTail.", k: 1 },
              { t: "Wrapper-binding codegen, not monkey-patching.", d: "PRD wanted us to monkey-patch DurableObjectNamespace.prototype.idFromName. Instead the bundle rewriter emits per-DO-class wrapper modules so customer code keeps using env.ChatRoom — every idFromName silently scoped to the PR.", k: 2 },
              { t: "Alarm-driven step machines.", d: "ProvisionRunner walks 5 steps; TeardownRunner walks 9. Each step's result is cached in DO storage by name — replays reuse the result, never re-call the CF API. Exponential backoff (1/2/4/8/16s), NonRetryableError short-circuits to compensating teardown.", k: 3 },
              { t: "Designed for CF API surprises.", d: "Newly-created D1/KV bindings take 2-5s to propagate to PUT /workers/scripts. We catch error codes 10181/10041/100100 inline and retry with a 2s gap, separate from the runner's outer backoff.", k: 4 },
              { t: "Closed-PR abort guard.", d: "At the top of every alarm tick the runner reads the PR env D1 row. If state is tearing_down/torn_down/failed, it markFailed() and exits — no more hammering the CF API against soon-to-be-deleted resources after a mid-provision PR close.", k: 5 },
              { t: "86 tests, all green.", d: "Vitest-pool-workers across 23 files: D1 CRUD round-trips, FK cascades, HMAC verify, JWT signing, ULID monotonicity, CF client retries, bundle rewriter, full provision + teardown alarm chains, signed-cookie auth, bundle-upload, queue → LogTail buffer.", k: 6 },
            ].map((c, i) => (
              <CapabilityCard key={i} idx={i + 1} title={c.t} desc={c.d} kind={c.k} />
            ))}
          </div>
        </div>
      </section>

      {/* STATS */}
      <section className="section stats">
        <div className="container">
          <div className={`stats-strip ${statsVisible ? "in" : ""}`}>
            {[
              { l: "Provision", v: "~6s", n: "Webhook → live preview" },
              { l: "Teardown steps", v: "9", n: "Idempotent on replay" },
              { l: "Tests", v: "86", n: "vitest-pool-workers, all green" },
              { l: "Cost / PR", v: "$0", n: "5 free-tier substitutions" },
            ].map((s, i) => (
              <div key={i} className="stat-cell" style={{ transitionDelay: `${i * 80}ms` }}>
                <span className="stat-label">{s.l}</span>
                <span className="stat-value">{s.v}</span>
                <span className="stat-note">{s.n}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* TERMINAL */}
      <section className="section terminal-sec">
        <div className="container">
          <div className="term-head" data-reveal>
            <Badge icon={<Icon d="M3 4h10v8H3z M5 6l2 2 -2 2" />} label="Architecture" />
            <h2 className="display center">Cloudflare-native, end to end.</h2>
          </div>
          <div className="terminal-artifact">
            <div className="bp-side bp-left-side">
              <BPLine side="left" title="raft-control" desc={"Webhooks, API,\ndashboard, cron"} top="40px" />
              <BPLine side="left" title="Durable Objects" desc={"5 SQLite-backed\nstate machines"} top="240px" />
              <BPLine side="left" title="D1 control plane" desc={"installations,\nrepos, pr_envs, audit"} top="430px" />
            </div>
            <div className="bp-side bp-right-side">
              <BPLine side="right" title="raft-dispatcher" desc={"Path-based proxy\nROUTES → user worker"} top="40px" />
              <BPLine side="right" title="Queues + KV + DOs" desc={"Free-tier-only\nsubstitutions throughout"} top="240px" />
              <BPLine side="right" title="raft-tail" desc={"Tail consumer →\nLogTail DO fan-out"} top="430px" />
            </div>
            <Terminal />
          </div>
        </div>
      </section>

      {/* TECH STACK */}
      <section className="section early-access" id="stack">
        <ShaderBars count={22} />
        <div className="container ea-content" data-reveal>
          <Badge icon={<span className="badge-pulse" />} label="Stack" />
          <h2 className="display center">TypeScript, end to end.</h2>
          <p className="lead center">
            TypeScript · Cloudflare Workers · D1 · Durable Objects · KV<br/>
            Queues · GitHub App · pnpm · Vitest · Wrangler v4
          </p>
          <form className="ea-form" onSubmit={handleSubmit}>
            <input
              type="email"
              className="ea-input"
              placeholder="you@company.com — we'll ping when v2 (Workers Paid path) lands"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              data-testid="ea-input"
            />
            <button className="btn btn-chamfer btn-flame" type="submit" data-testid="ea-submit">
              {submitted ? "Logged ✓" : "Notify me"}
            </button>
          </form>
        </div>
      </section>

      {/* FAQ */}
      <section className="section faq" id="faq">
        <div className="container">
          <div className="faq-head" data-reveal>
            <Badge icon={<Icon d="M5 6a3 3 0 1 1 5 2c-1 1-2 1-2 3 M8 13v.01" />} label="FAQ" />
            <h2 className="display center">Frequently asked questions.</h2>
          </div>
          <div className="faq-list">
            {FAQS.map((f, i) => (
              <FaqItem
                key={i}
                num={String(i + 1).padStart(2, "0")}
                q={f.q}
                a={f.a}
                open={openFaq === i}
                onClick={() => setOpenFaq(openFaq === i ? -1 : i)}
              />
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="section cta-section">
        <div className="cta-vortex" style={{ backgroundImage: "url(/figma-assets/cta-vortex.png)" }} />
        <div className="container cta-content">
          <p className="cta-fine">$0 per PR. No paid Cloudflare add-ons required.</p>
          <div className="cta-logo">
            <RigLogo size={56} color="#F0EDE6" />
          </div>
          <h2 className="cta-headline glitch" data-text="Every PR gets&#10;its own Cloudflare">Every PR gets<br/>its own Cloudflare</h2>
          <a href="https://github.com/apps/rift-aditya" className="btn btn-chamfer btn-flame btn-xl" data-testid="cta-final" target="_blank" rel="noreferrer">
            Install on GitHub
            <span className="btn-arrow"><svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7h8m-3-3l3 3-3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg></span>
          </a>
        </div>
      </section>

      {/* FOOTER */}
      </div> {/* end frame-col */}
      <footer className="footer">
        <div className="container">
          <div className="footer-grid">
            <div className="footer-brand">
              <RigLogo size={22} color="#F0EDE6" />
              <p>Per-PR Cloudflare environments<br/>that clean themselves up.</p>
            </div>
            <div className="footer-col">
              <h4>Product</h4>
              <a href="#capabilities" className="foot-link">Engineering</a>
              <a href="#approach" className="foot-link">How it works</a>
              <a href="#stack" className="foot-link">Stack</a>
            </div>
            <div className="footer-col">
              <h4>Source</h4>
              <a href="https://github.com/Adi-gitX/Rift" className="foot-link" target="_blank" rel="noreferrer">GitHub repo</a>
              <a href="https://github.com/Adi-gitX/Rift/blob/main/rift_PRD.md" className="foot-link" target="_blank" rel="noreferrer">PRD</a>
              <a href="https://github.com/Adi-gitX/Rift/blob/main/docs/AMENDMENTS-DAY-1.md" className="foot-link" target="_blank" rel="noreferrer">Amendments</a>
            </div>
            <div className="footer-col">
              <h4>Live</h4>
              <a href="/dashboard" className="foot-link">Dashboard</a>
              <a href="https://raft-control.adityakammati3.workers.dev/healthz" className="foot-link" target="_blank" rel="noreferrer">/healthz</a>
              <a href="https://raft-control.adityakammati3.workers.dev/version" className="foot-link" target="_blank" rel="noreferrer">/version</a>
            </div>
          </div>
          <div className="footer-bottom">
            <span>Built by Aditya Kammati. Source: github.com/Adi-gitX/Rift</span>
            <span className="status"><span className="status-dot" /> raft-control v3 live</span>
          </div>
        </div>
      </footer>

      {/* Global film grain + scanlines + rgb fringe (rig.ai-style overlays) */}
      <div className="noise" aria-hidden />
      <div className="scanlines" aria-hidden />
      <div className="rgb-fringe" aria-hidden />
    </div>
  );
}

export default App;
