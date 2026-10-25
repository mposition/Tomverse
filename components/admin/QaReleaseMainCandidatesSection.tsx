"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { card } from "@/components/admin/qaReleaseTabParts";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import type { QaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesCore";

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

/**
 * S-M3 (docs/policy/qa-release-agent.md section 8 item 1): open pull requests
 * into main and whether this build serves main's head. A person merges main;
 * this list is not a readiness verdict.
 */
export function QaReleaseMainCandidatesSection({ data, id }: { data: QaReleaseMainCandidates; id?: string }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const { production, pullRequests } = data;
  const serving =
    production.servesMainHead === null ? m.mainServingUnknown : production.servesMainHead ? m.mainServingHead : m.mainServingBehind;
  return (
    <section className={`${card} flex min-w-0 flex-col gap-3`} id={id} data-testid="qa-release-main-candidates">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-zinc-100">{m.mainSectionTitle}</h2>
        <p className="text-xs text-zinc-400">{m.mainNote}</p>
      </div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
        <span>{production.environment}</span>
        <span className="font-mono text-zinc-300">
          {short(production.servingSha) ?? m.none} → {short(production.mainHeadSha) ?? m.none}
        </span>
        <span
          className={production.servesMainHead === false ? "text-amber-300" : production.servesMainHead ? "text-emerald-400" : ""}
          data-testid="qa-release-main-serving"
        >
          {serving}
        </span>
      </p>
      {pullRequests === null ? (
        <p className="text-sm text-amber-300">
          {m.mainUnread}
          {data.readFailure ? m.githubFailure.replace("{failure}", data.readFailure) : ""}
        </p>
      ) : pullRequests.length === 0 ? (
        <p className="text-sm text-zinc-400">{m.mainNone}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-zinc-800 rounded-xl border border-zinc-800">
          {pullRequests.map((pull) => (
            <li key={pull.number} className="flex items-center gap-3 px-3 py-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <a className="truncate text-sm font-medium text-zinc-100 hover:underline" href={pull.url} target="_blank" rel="noreferrer">
                  #{pull.number} {pull.title}
                </a>
                <span className="truncate font-mono text-xs text-zinc-500">{pull.head}</span>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${
                  !pull.allowed
                    ? "bg-red-400/15 text-red-300"
                    : pull.draft
                      ? "bg-zinc-700/60 text-zinc-300"
                      : "bg-emerald-400/15 text-emerald-400"
                }`}
                title={pull.allowed ? m.mainAllowed : m.mainRefused}
              >
                {!pull.allowed ? m.mainPillRefused : pull.draft ? m.mainDraft : m.mainPillOpen}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
