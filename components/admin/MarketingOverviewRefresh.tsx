"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * The Overview's refresh control. The console payload is read again through
 * `onRefresh`, and the route is refreshed too, because the Overview's own
 * figures (scheduled posts, posts per day, recent runs) come from the page's
 * server component and a payload refetch alone would leave them stale.
 */
export function MarketingOverviewRefresh({ busy, onRefresh }: { busy: boolean; onRefresh: () => void }) {
  const m = useAdminMessages(adminMarketingMessages);
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={() => {
        onRefresh();
        router.refresh();
      }}
      disabled={busy}
      className="inline-flex min-h-11 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3.5 py-2 text-[13px] font-semibold text-zinc-100 transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      {m.refresh}
    </button>
  );
}
