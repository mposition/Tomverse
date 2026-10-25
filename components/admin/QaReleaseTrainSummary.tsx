"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { aestStamp } from "@/lib/agentOffice/time";
import { adminQaReleaseTrainMessages } from "@/lib/adminMessages/qaReleaseTrain";

const PR_URL = "https://github.com/mposition/Tomverse/pull/";

/** The release train tab's three figures: when the next train leaves, what rides it, and the train still open. */
export function QaReleaseTrainSummary({
  nextDepartureAt,
  riding,
  carried,
  openTrain,
  emergencyPending,
}: {
  nextDepartureAt: string | null;
  riding: number;
  carried: number;
  openTrain: number | null;
  emergencyPending: boolean;
}) {
  const m = useAdminMessages(adminQaReleaseTrainMessages);
  const tile = "flex min-w-0 flex-col gap-0.5 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3";
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-3" data-testid="qa-release-train-summary">
      <div className={tile}>
        <span className="text-xs text-zinc-400">{m.summaryNext}</span>
        <span className="font-mono text-xl font-semibold text-zinc-100">{nextDepartureAt ? aestStamp(nextDepartureAt) : m.summaryNextUnknown}</span>
        {emergencyPending ? <span className="text-xs text-red-300">{m.summaryEmergency}</span> : null}
      </div>
      <div className={tile}>
        <span className="text-xs text-zinc-400">{m.summaryRiding}</span>
        <span className="font-mono text-xl font-semibold text-zinc-100">{riding}</span>
        <span className="text-xs text-zinc-400">
          {m.summaryRidingDetail.replace("{carried}", String(carried)).replace("{fresh}", String(Math.max(0, riding - carried)))}
        </span>
      </div>
      <div className={tile}>
        <span className="text-xs text-zinc-400">{m.summaryOpen}</span>
        {openTrain !== null ? (
          <a className="font-mono text-xl font-semibold text-blue-300 hover:underline" href={`${PR_URL}${openTrain}`} target="_blank" rel="noreferrer">
            #{openTrain}
          </a>
        ) : (
          <span className="font-mono text-xl font-semibold text-zinc-100">{m.summaryOpenNone}</span>
        )}
        {openTrain !== null ? <span className="text-xs text-zinc-400">{m.summaryOpenNote}</span> : null}
      </div>
    </div>
  );
}
