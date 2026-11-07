"use client";

import { ChevronRight } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminUiMessages } from "@/lib/adminMessages/ui";

/**
 * Where internal detail goes: policy versions, record ids, raw payloads.
 * Closed by default, so the page reads in plain words and the evidence is one
 * click away rather than gone.
 */
export function AdminTechInfo({
  summary,
  children,
  defaultOpen = false,
}: {
  /** A short list of what is inside, shown beside the title while closed. */
  summary?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const m = useAdminMessages(adminUiMessages);
  return (
    <details
      open={defaultOpen}
      className="group rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm text-zinc-400"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open:rotate-90" aria-hidden />
        <span className="font-bold text-zinc-100">{m.techInfo}</span>
        {summary ? <span className="truncate text-xs text-zinc-500">{summary}</span> : null}
      </summary>
      <div className="mt-3 border-t border-zinc-800 pt-3 font-mono text-xs text-zinc-300">{children}</div>
    </details>
  );
}
