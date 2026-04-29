import React, { useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Mouse-following glow card — Aceternity "card-spotlight" pattern.
 * Tracks cursor and reveals a soft radial gradient.
 */
export const GlowCard = ({ children, className, glowColor = "237, 70, 45" }) => {
  const ref = useRef(null);

  const onMouseMove = (e) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - rect.left}px`);
    el.style.setProperty("--my", `${e.clientY - rect.top}px`);
  };

  return (
    <div
      ref={ref}
      onMouseMove={onMouseMove}
      className={cn(
        "group relative overflow-hidden rounded-xl border border-white/[0.06] bg-[#0f0f0f] transition-colors duration-200",
        "hover:border-white/[0.12]",
        className
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
        style={{
          background: `radial-gradient(280px circle at var(--mx, 50%) var(--my, 50%), rgba(${glowColor}, 0.18), transparent 60%)`,
        }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
};
