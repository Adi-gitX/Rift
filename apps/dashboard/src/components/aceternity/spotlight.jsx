import React from "react";
import { cn } from "@/lib/utils";

/**
 * Subtle spotlight gradient anchored to a corner — Aceternity style.
 * Pure CSS, no JS, decorative only.
 */
export const Spotlight = ({ className, fill = "#ED462D" }) => (
  <div
    aria-hidden
    className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
  >
    <div
      className="absolute -top-40 -left-40 h-[520px] w-[520px] rounded-full blur-[120px] opacity-[0.18]"
      style={{ background: `radial-gradient(closest-side, ${fill}, transparent)` }}
    />
    <div
      className="absolute top-1/3 -right-40 h-[420px] w-[420px] rounded-full blur-[120px] opacity-[0.10]"
      style={{ background: `radial-gradient(closest-side, #ffffff, transparent)` }}
    />
  </div>
);
