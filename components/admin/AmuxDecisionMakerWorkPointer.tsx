"use client";

import Link from "next/link";
import { ArrowRight, Bot } from "lucide-react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxDecisionMakerAttentionMessages } from "@/lib/adminMessages/amuxDecisionMaker";

/**
 * Operations settings › Decision Maker holds the switches and the history; the
 * requests that wait on a person are judged in AMUX › Execution. This line says
 * so, how many wait, and where. `waiting` null is a failed read: no count is
 * shown rather than a zero. `href` null: this reader opens them from the list.
 */
export function AmuxDecisionMakerWorkPointer({ waiting, href }: { waiting: number | null; href: string | null }) {
  const d = useAdminMessages(adminAmuxDecisionMakerAttentionMessages);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-sky-800 bg-sky-950/50 px-4 py-2 text-sm text-sky-200"
      data-testid="amux-dm-work-pointer"
    >
      <Bot className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 py-2">{waiting === 0 ? d.settingsNone : d.settingsPointer}</p>
      {waiting !== null && waiting > 0 && href !== null ? (
        <Link href={href} className="inline-flex min-h-11 items-center gap-1.5 font-semibold" data-testid="amux-dm-work-pointer-open">
          {d.settingsOpen(waiting)}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      ) : null}
    </div>
  );
}
