"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAgentDigestsMessages } from "@/lib/adminMessages/agentDigests";
import type { QaReleaseMainCandidates } from "@/lib/qaReleaseMainCandidatesCore";

const short = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

/**
 * S-M3 (docs/policy/qa-release-agent.md section 8 item 1): open pull requests
 * into main and whether this build serves main's head. A person merges main;
 * this list is not a readiness verdict.
 */
export function QaReleaseMainCandidatesSection({ data }: { data: QaReleaseMainCandidates }) {
  const m = useAdminMessages(adminAgentDigestsMessages);
  const { production, pullRequests } = data;
  const serving =
    production.servesMainHead === null ? m.mainServingUnknown : production.servesMainHead ? m.mainServingHead : m.mainServingBehind;
  return (
    <div className="flex flex-col gap-2" data-testid="qa-release-main-candidates">
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">{m.mainTitle}</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.mainNote}</p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-600 dark:text-zinc-400">{m.mainEnvironment}</dt>
        <dd>{production.environment}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.mainServing}</dt>
        <dd className="font-mono text-xs">{short(production.servingSha) ?? m.none}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.mainHead}</dt>
        <dd className="font-mono text-xs">{short(production.mainHeadSha) ?? m.none}</dd>
        <dt className="text-zinc-600 dark:text-zinc-400">{m.mainState}</dt>
        <dd data-testid="qa-release-main-serving">{serving}</dd>
      </dl>
      {pullRequests === null ? (
        <p className="text-sm text-amber-800 dark:text-amber-300">{m.mainUnread}</p>
      ) : pullRequests.length === 0 ? (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">{m.mainNone}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {pullRequests.map((pull) => (
            <li key={pull.number} className="flex flex-col">
              <a className="text-blue-700 underline dark:text-blue-300" href={pull.url} target="_blank" rel="noreferrer">
                #{pull.number} {pull.title}
              </a>
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                <span className="font-mono">{pull.head}</span>
                {pull.draft ? ` · ${m.mainDraft}` : ""} · {pull.allowed ? m.mainAllowed : m.mainRefused}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
