import React from "react";
import { cn } from "@/lib/utils";

export const GridBackground = ({ className }) => (
  <div
    aria-hidden
    className={cn(
      "pointer-events-none absolute inset-0",
      "[background-image:linear-gradient(to_right,rgba(240,237,230,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(240,237,230,0.04)_1px,transparent_1px)]",
      "[background-size:40px_40px]",
      "[mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]",
      className
    )}
  />
);

export const DotPattern = ({ className }) => (
  <div
    aria-hidden
    className={cn(
      "pointer-events-none absolute inset-0",
      "[background-image:radial-gradient(rgba(240,237,230,0.07)_1px,transparent_1px)]",
      "[background-size:18px_18px]",
      "[mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_75%)]",
      className
    )}
  />
);
