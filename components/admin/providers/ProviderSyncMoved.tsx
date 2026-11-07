"use client";

import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminProviderBoardMessages } from "@/lib/adminMessages/providerBoard";

/**
 * Where the usage sync button used to sit on the Status tab and on a
 * provider's own page. The one button is on Usage & cost; this only points
 * there, so nothing on these screens writes.
 */
export function ProviderSyncMoved() {
  const m = useAdminMessages(adminProviderBoardMessages).syncMoved;
  return (
    <div
      data-testid="provider-sync-moved"
      className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-900 px-5 py-4"
    >
      <RefreshCw className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold text-white">{m.title}</p>
        <p className="text-xs text-zinc-400">{m.detail}</p>
      </div>
      <Link
        href="/admin/providers?tab=usage-cost"
        className="inline-flex min-h-9 shrink-0 items-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800"
      >
        {m.link}
      </Link>
    </div>
  );
}
