"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminPixelAvatar } from "@/components/admin/ui/AdminPixelAvatar";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { adminFetch } from "@/lib/adminFetch";
import { adminModelsBoardMessages } from "@/lib/adminMessages/modelsBoard";

type QueueItem = {
  familyKey: string;
  apiModel: string;
  action: string;
  status: string;
  product: string;
};

/** What the discovery queue still has to decide, as an adoptable chat model. */
const OPEN_STATUSES = new Set(["discovered", "awaiting_decision", "deferred"]);
const NAMES_SHOWN = 3;

/**
 * Names the new models the Scout found, as a banner above the registry.
 *
 * It reads the same queue the Discovery tab reads and counts only what is
 * still undecided and adoptable as a chat model. If the queue cannot be read
 * it says so: a missing banner would otherwise read as "nothing is new".
 */
export function NewModelsBanner({ discoveryHref = "/admin/models?tab=discovery" }: { discoveryHref?: string }) {
  const m = useAdminMessages(adminModelsBoardMessages).banner;
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "failed" } | { kind: "ready"; names: string[] }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    void adminFetch("/api/admin/model-lifecycle", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json()) as { items?: QueueItem[] };
        if (!Array.isArray(data.items)) throw new Error("shape");
        const families = new Map<string, string>();
        for (const item of data.items) {
          if (item.action !== "add" || item.product !== "chat" || !OPEN_STATUSES.has(item.status)) continue;
          if (!families.has(item.familyKey)) families.set(item.familyKey, item.apiModel);
        }
        if (!cancelled) setState({ kind: "ready", names: [...families.values()] });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") return null;
  if (state.kind === "failed") {
    return <AdminStateBlock kind="error" title={m.unreadable} detail={m.unreadableDetail} />;
  }
  if (state.names.length === 0) return null;

  const shown = state.names.slice(0, NAMES_SHOWN).join(", ");
  const rest = state.names.length - NAMES_SHOWN;
  const names = rest > 0 ? `${shown} ${m.more(rest)}` : shown;
  return (
    <div
      data-testid="model-registry-new-models-banner"
      className="flex flex-wrap items-center gap-4 rounded-2xl border border-blue-500/30 bg-blue-500/10 p-4"
    >
      <AdminPixelAvatar team="research" unit={3} tile={52} />
      <div className="min-w-0 flex-1">
        <p className="font-bold text-zinc-100">{m.title(state.names.length)}</p>
        <p className="mt-0.5 text-sm text-zinc-400">{m.detail(names)}</p>
      </div>
      <Link
        href={discoveryHref}
        className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-bold text-white hover:bg-blue-500"
      >
        <ArrowRight className="h-4 w-4" aria-hidden />
        {m.action}
      </Link>
    </div>
  );
}
