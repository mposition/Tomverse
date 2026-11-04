"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { card } from "@/components/admin/qaReleaseTabParts";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import { aestStamp } from "@/lib/agentOffice/time";
import type { QaReleaseCiAdviceRecord } from "@/lib/qaReleaseCiAdviceCore";

/** What the daily CI suggestion round last said (lib/qaReleaseCiAdviceCore.ts). A proposal to read; nothing acts on it. */
export function QaReleaseCiAdviceSection({ advice }: { advice: QaReleaseCiAdviceRecord | null }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  if (advice === null || advice.answeredAt === null) return null;
  return (
    <section className={`${card} flex min-w-0 flex-col gap-3`} data-testid="qa-release-ci-advice">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-zinc-100">{m.ciAdviceTitle}</h2>
        <span className="text-xs text-zinc-500">{m.ciAdviceAt.replace("{at}", aestStamp(advice.answeredAt))}</span>
      </div>
      {advice.suggestions.length === 0 ? (
        <p className="text-sm text-zinc-400">{m.ciAdviceNone}</p>
      ) : (
        <ol className="flex flex-col divide-y divide-zinc-800">
          {advice.suggestions.map((suggestion, index) => (
            <li key={index} className="flex min-w-0 flex-col gap-1 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="min-w-0 break-words text-sm font-medium text-zinc-100">{suggestion.title}</span>
                {suggestion.savesMinutes !== null ? (
                  <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
                    {m.ciAdviceSaves.replace("{minutes}", String(suggestion.savesMinutes))}
                  </span>
                ) : null}
              </div>
              <p className="break-words text-xs text-zinc-400">{suggestion.why}</p>
              <p className="break-words text-xs text-zinc-300">{suggestion.change}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
