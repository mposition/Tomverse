"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxWorkspaceMessages } from "@/lib/adminMessages/amuxWorkspace";

/**
 * One retired AMUX tool inside Safety & recovery › Legacy tools.
 *
 * Closed by default, and its panel is not mounted until it is opened: each of
 * these panels reads its own rows on mount, and six of them fetching because an
 * operator opened one tab is the cost the old one-panel-per-page layout never
 * had. Once opened it stays mounted, so closing it does not throw away what
 * the operator typed.
 */
export function AmuxLegacyToolSection({
  id,
  title,
  chip,
  attention = false,
  children,
}: {
  id: string;
  title: string;
  /** The section's switch state, read on the server (lib/adminAmuxTabStatus.ts). */
  chip?: string;
  attention?: boolean;
  children: ReactNode;
}) {
  const m = useAdminMessages(adminAmuxWorkspaceMessages).legacy;
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <details
      id={id}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        if (next) setOpened(true);
      }}
      className="group rounded-2xl border border-zinc-800 bg-zinc-900 px-5 py-4"
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-base font-bold text-white">{title}</span>
        {chip ? (
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
              attention ? "bg-blue-500/15 text-blue-300" : "bg-zinc-800 text-zinc-400"
            }`}
          >
            {chip}
          </span>
        ) : null}
        <span className="shrink-0 text-xs font-medium text-zinc-400">{open ? m.close : m.open}</span>
      </summary>
      {opened ? <div className="mt-4 min-w-0">{children}</div> : null}
    </details>
  );
}
