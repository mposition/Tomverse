"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminUiMessages } from "@/lib/adminMessages/ui";
import type { AdminTone } from "@/lib/adminUiCore";

// Static strings so Tailwind sees every class. Dark classes only: Light is a
// palette remap (docs/ui-contracts/admin-console-ia.md, "The console theme").
const TONE_CLASS: Record<AdminTone, string> = {
  ok: "bg-emerald-500/15 text-emerald-300",
  warn: "bg-amber-500/15 text-amber-300",
  bad: "bg-red-500/15 text-red-300",
  info: "bg-blue-500/15 text-blue-300",
  idle: "bg-zinc-800 text-zinc-300",
  unknown: "border border-dashed border-zinc-700 text-zinc-400",
};

/**
 * A status, in one of the five colours the console allows. Without
 * `children` it says the tone's own word ("Healthy", "Unavailable", ...), so
 * an unread value is labelled as unread rather than as healthy.
 */
export function AdminStatusChip({
  tone,
  children,
  className = "",
}: {
  tone: AdminTone;
  children?: React.ReactNode;
  className?: string;
}) {
  const m = useAdminMessages(adminUiMessages);
  return (
    <span
      data-tone={tone}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold ${TONE_CLASS[tone]} ${className}`}
    >
      {children ?? m.tone[tone]}
    </span>
  );
}
