"use client";

import { adminModelDiscoveryMessages } from "@/lib/adminMessages/modelDiscovery";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import type { NewProviderResearchRunRecord } from "@/lib/modelDiscoveryNewProviderResearchCore";

/**
 * The weekly research's last run: what each call proposed, what was filed, and
 * why every other proposal was dropped. A run that rejected everything must not
 * look like a run that found nothing.
 */
export function AdminModelDiscoveryResearchRun({ run }: { run: NewProviderResearchRunRecord | null }) {
  const m = useAdminMessages(adminModelDiscoveryMessages).research;
  return (
    <AdminTile title={m.title} description={run ? m.ranAt(new Date(run.ranAt).toLocaleString(), run.week, run.modelId) : m.none}>
      {run ? (
        <ul className="flex flex-col gap-3" data-testid="model-discovery-research-run">
          {run.calls.map((call) => (
            <li key={call.product} className="flex flex-col gap-1 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-bold text-zinc-100">{m.call[call.product] ?? call.product}</span>
                <span className="text-xs text-zinc-400">{call.ok ? m.counts(call.proposed, call.accepted) : m.failed}</span>
              </div>
              {call.rejected.length > 0 ? (
                <div className="flex flex-col gap-1 pl-3">
                  <span className="text-xs text-zinc-500">{m.rejectedHeading}</span>
                  {call.rejected.map((rejection, index) => (
                    <div key={`${rejection.apiModelId}-${index}`} className="text-xs text-zinc-300">
                      <span className="font-mono">
                        {rejection.providerName || "?"} / {rejection.apiModelId || "?"}
                      </span>
                      {" — "}
                      {m.reason[rejection.reason] ?? rejection.reason}
                      {rejection.citedUrls && rejection.citedUrls.length > 0 ? (
                        <span className="block break-all pl-3 text-zinc-500">
                          {m.citedUrls} {rejection.citedUrls.join(", ")}
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </AdminTile>
  );
}
