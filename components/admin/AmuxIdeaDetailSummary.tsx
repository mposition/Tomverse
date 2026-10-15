"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { AMUX_IDEA_PROGRESS_STAGES, amuxIdeaProgressStep } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const REPOSITORY_URL = "https://github.com/mposition/Tomverse";
/** The steps a person takes; every other step runs on its own. */
const HUMAN_STEPS = new Set(["execution_approval", "plan_approval", "review"]);

/**
 * The top of one idea's detail (approved backlog redesign, B3): where the idea
 * is on the six steps, which of them are a person's, and its Tasks with their
 * PRs. Everything here is read from the progress snapshot; there is no action
 * besides opening GitHub, because the human steps have their own panels below
 * and a merge is observed by the app rather than approved again here.
 */
export function AmuxIdeaDetailSummary({ row }: { row: AmuxIdeaProgressRow }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const step = amuxIdeaProgressStep(row.stage);
  return (
    <section className="space-y-4 rounded-xl border border-zinc-200 bg-white p-4 text-sm dark:border-zinc-800 dark:bg-zinc-950"
      aria-labelledby="amux-idea-detail-heading" data-testid="amux-idea-detail" data-stage={row.stage}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="amux-idea-detail-heading" className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {row.displayKey ?? `${m.untitled} ${row.requestId.slice(0, 8)}`}
        </h2>
        <Link href="/admin/amux-backlog?tab=ideas" className="min-h-11 content-center text-sm font-medium text-blue-800 underline dark:text-blue-200">
          {m.backToList}
        </Link>
      </div>
      {row.attention ? <p role="alert" className="text-red-800 dark:text-red-200">{m.attentionDetail}</p> : null}
      <ol className="grid gap-2 sm:grid-cols-6" aria-label={m.stepsLabel}>
        {AMUX_IDEA_PROGRESS_STAGES.map((stage, index) => {
          const position = index + 1;
          const state = step === null ? "later" : position < step ? "done" : position === step ? "current" : "later";
          return (
            <li key={stage} aria-current={state === "current" ? "step" : undefined}
              className={`rounded-lg border p-2 ${state === "current"
                ? (row.attention ? "border-red-400" : HUMAN_STEPS.has(stage) ? "border-amber-400" : "border-blue-400")
                : state === "done" ? "border-blue-200 dark:border-blue-900" : "border-zinc-200 dark:border-zinc-800"}`}>
              <span className="block text-xs text-zinc-500 dark:text-zinc-400">{position}</span>
              <span className="block font-medium text-zinc-900 dark:text-zinc-100">{m.stages[stage]}</span>
              <span className="block text-xs text-zinc-600 dark:text-zinc-400">
                {state === "done" ? m.stepDone : HUMAN_STEPS.has(stage) ? m.human : m.automatic}
              </span>
            </li>
          );
        })}
      </ol>
      {row.stage === "cancelled" ? <p>{m.stages.cancelled}</p> : null}
      {row.taskRows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] text-left text-sm">
            <caption className="sr-only">{m.tasksCaption}</caption>
            <thead className="text-xs text-zinc-600 dark:text-zinc-400">
              <tr><th className="py-1 pr-3 font-medium">{m.taskColumn}</th>
                <th className="py-1 pr-3 font-medium">{m.statusColumn}</th>
                <th className="py-1 font-medium">{m.prColumn}</th></tr>
            </thead>
            <tbody>
              {row.taskRows.map((task, index) => (
                <tr key={task.displayKey ?? index} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="py-2 pr-3 font-mono text-xs">{task.displayKey ?? "—"}</td>
                  <td className="py-2 pr-3">{task.merged ? m.taskMerged : task.status}</td>
                  <td className="py-2">
                    {task.reviewPrNumber !== null ? (
                      <a href={`${REPOSITORY_URL}/pull/${task.reviewPrNumber}`} target="_blank" rel="noreferrer"
                        className="inline-flex min-h-11 items-center font-medium text-blue-800 underline dark:text-blue-200">
                        PR #{task.reviewPrNumber}{!task.merged && task.status === "review" ? ` · ${m.reviewOnGithub}` : ""} ↗
                      </a>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-zinc-600 dark:text-zinc-400">{m.mergeObserved}</p>
        </div>
      ) : null}
    </section>
  );
}
