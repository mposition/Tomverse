"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";

export type QaReleaseTrainView = {
  slot: string;
  at: string;
  outcome: "opened" | "empty" | "failed";
  pullRequestNumber: number | null;
  failure: string | null;
  picks: { number: number; outcome: "included" | "already_in_main" | "conflict" | "over_capacity" }[];
};

const PR_URL = "https://github.com/mposition/Tomverse/pull/";

/**
 * The release train (docs/policy/qa-release-agent.md section 8 item 12): the
 * newest trains, what rode and what was left out and why. Read from the audit
 * rows the train writes; a person merges the main pull request.
 */
export function QaReleaseTrainSection({ trains }: { trains: QaReleaseTrainView[] }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const pick = (outcome: QaReleaseTrainView["picks"][number]["outcome"]) =>
    ({ included: m.trainIncluded, already_in_main: m.trainAlready, conflict: m.trainConflict, over_capacity: m.trainOverCapacity })[outcome];
  return (
    <div className="flex flex-col gap-2" data-testid="qa-release-train">
      <h2 className="text-base font-semibold text-zinc-100">{m.trainTitle}</h2>
      <p className="text-sm text-zinc-400">{m.trainNote}</p>
      {trains.length === 0 ? (
        <p className="text-sm text-zinc-400">{m.trainNone}</p>
      ) : (
        <ul className="flex flex-col gap-3 text-sm">
          {trains.map((train) => (
            <li key={`${train.slot}-${train.at}`} className="flex flex-col gap-1">
              <span className="text-zinc-100">
                <span className="font-mono">{train.slot}</span> ·{" "}
                {train.outcome === "opened" && train.pullRequestNumber !== null ? (
                  <a className="text-blue-300 underline" href={`${PR_URL}${train.pullRequestNumber}`} target="_blank" rel="noreferrer">
                    #{train.pullRequestNumber}
                  </a>
                ) : train.outcome === "empty" ? (
                  m.trainEmpty
                ) : (
                  <span className="text-amber-300">
                    {m.trainFailed} ({train.failure ?? m.none})
                  </span>
                )}
              </span>
              <span className="text-xs text-zinc-400">{train.at}</span>
              {train.picks.length > 0 ? (
                <ul className="flex flex-col text-xs">
                  {train.picks.map((p) => (
                    <li key={p.number} className={p.outcome === "conflict" ? "text-amber-300" : "text-zinc-400"}>
                      <a className="underline" href={`${PR_URL}${p.number}`} target="_blank" rel="noreferrer">
                        #{p.number}
                      </a>{" "}
                      {pick(p.outcome)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
