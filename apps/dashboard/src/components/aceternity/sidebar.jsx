import React, { createContext, useContext, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "@/lib/utils";
import { Menu, X } from "lucide-react";

const SidebarContext = createContext(undefined);

export const useSidebar = () => {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be inside SidebarProvider");
  return ctx;
};

export const SidebarProvider = ({ children, open: openProp, setOpen: setOpenProp, animate = true }) => {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = setOpenProp ?? setOpenState;
  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>
      {children}
    </SidebarContext.Provider>
  );
};

export const Sidebar = ({ children, open, setOpen, animate }) => (
  <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
    {children}
  </SidebarProvider>
);

/**
 * DesktopSidebar - sticky, full-viewport-height, hover-to-expand.
 * Children should use the AnimatedLabel below for elements that fade with width.
 */
export const DesktopSidebar = ({ className, children, ...props }) => {
  const { open, setOpen, animate } = useSidebar();
  return (
    <motion.aside
      data-testid="dashboard-sidebar"
      className={cn(
        "hidden md:flex md:flex-col shrink-0 sticky top-0 self-start h-screen",
        "bg-[#0a0a0a]/85 backdrop-blur-md border-r border-white/[0.06] z-[1]",
        className
      )}
      animate={{ width: animate ? (open ? 240 : 64) : 240 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      {...props}
    >
      {children}
    </motion.aside>
  );
};

export const MobileSidebar = ({ className, children }) => {
  const { open, setOpen } = useSidebar();
  return (
    <div className={cn("md:hidden flex items-center justify-between px-4 py-3 bg-[#0a0a0a] border-b border-white/[0.06]")}>
      <button onClick={() => setOpen(!open)} aria-label="Toggle sidebar" className="text-white/80" data-testid="sidebar-mobile-toggle">
        <Menu size={20} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ x: "-100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: "-100%", opacity: 0 }}
            transition={{ duration: 0.25, ease: "easeInOut" }}
            className={cn("fixed inset-0 z-[100] flex flex-col bg-[#0a0a0a] p-6", className)}
          >
            <button onClick={() => setOpen(false)} className="absolute top-5 right-5 text-white/80" aria-label="Close sidebar">
              <X size={20} />
            </button>
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

/** Animated label that fades & collapses with the sidebar width. */
export const AnimatedLabel = ({ children, className, ...props }) => {
  const { open, animate } = useSidebar();
  return (
    <motion.span
      animate={{
        opacity: animate ? (open ? 1 : 0) : 1,
        width: animate ? (open ? "auto" : 0) : "auto",
      }}
      transition={{ duration: 0.2 }}
      className={cn("overflow-hidden whitespace-nowrap", className)}
      {...props}
    >
      {children}
    </motion.span>
  );
};

export const SidebarLink = ({ link, className, active, ...props }) => (
  <button
    type="button"
    onClick={link.onClick}
    data-testid={link.testid || `sidebar-link-${link.label?.toLowerCase().replace(/\s+/g, "-")}`}
    className={cn(
      "group/sidebar relative flex items-center gap-3 py-2 px-2 rounded-md w-full text-left",
      "text-white/55 hover:text-white hover:bg-white/[0.04] transition-colors duration-150",
      active && "text-white bg-white/[0.06]",
      className
    )}
    {...props}
  >
    {/* active accent bar */}
    {active && (
      <span aria-hidden className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r bg-[#ED462D]" />
    )}
    <span className="shrink-0 w-5 h-5 flex items-center justify-center">{link.icon}</span>
    <AnimatedLabel className="text-[13px] font-medium">{link.label}</AnimatedLabel>
  </button>
);
