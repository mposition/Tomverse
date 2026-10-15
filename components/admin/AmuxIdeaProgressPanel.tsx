"use client";

import Link from "next/link";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { amuxIdeaHasUnsavedDraft } from "@/lib/amux/ideaDraftGuard";
import { amuxIdeaProgressStep, type AmuxIdeaWaitingFor } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const REPOSITORY_URL = "https://github.com/mposition/Tomverse";
const HUMAN_STAGES = new Set(["execution_approval", "plan_approval", "review"]);
const BRISBANE = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hour12: false,
});
const when = (iso: string) => BRISBANE.format(new Date(iso));
export const amuxIdeaHref = (requestId: string) =>
  `/admin/amux-backlog?${new URLSearchParams({ tab: "ideas", idea: requestId })}`;

/**
 * The top of the Ideas tab in the approved v49 backlog redesign: "Decide now"
 * lifts only the human steps (execution approval, plan approval, a PR waiting
 * for GitHub review), and "Ideas in progress" shows every recent idea on the
 * six-step bar. Rows come from one bounded server read; `null` is a failed
 * read, shown as unavailable and never as an empty list.
 */
export function AmuxIdeaProgressPanel({ rows, activeRequestId }: {
  /** null: the read failed; "reauthenticate": the owner's sign-in is not recent. */
  rows: AmuxIdeaProgressRow[] | null | "reauthenticate";
  activeRequestId: string | null;
}) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const keepDraft = (event: { preventDefault: () => void }) => {
    if (amuxIdeaHasUnsavedDraft() && !window.confirm(m.leaveDraft)) event.preventDefault();
  };
  if (rows === "reauthenticate") {
    return <p role="status" className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800"
      data-testid="amux-idea-progress-reauthenticate">
      {m.reauthenticate}{" "}
      <a className="font-medium underline" href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.signIn}</a>
    </p>;
  }
  if (rows === null) {
    return <p role="alert" className="rounded-xl border border-red-200 p-4 text-sm text-red-800 dark:border-red-900 dark:text-red-200"
      data-testid="amux-idea-progress-unavailable">{m.unavailable}</p>;
  }
  const label = (row: AmuxIdeaProgressRow) => row.displayKey ?? `${m.untitled} ${row.requestId.slice(0, 8)}`;
  const decisions = rows.filter((row) => row.waitingFor !== null);
  const decision: Record<AmuxIdeaWaitingFor, [string, string]> = {
    execution_approval: [m.executionApproval, m.executionApprovalHint],
    continuation: [m.continuationApproval, m.continuationHint],
    owner_input: [m.ownerInput, m.ownerInputHint],
    plan_approval: [m.planApproval, m.planApprovalHint],
  };
  const reviews = rows.flatMap((row) => row.reviewPullRequests.map((pr) => ({ row, pr })));
  const waiting = decisions.length + reviews.length;

  return (
    <div className="flex flex-col gap-5" data-testid="amux-idea-progress">
      <section aria-labelledby="amux-idea-inbox-heading"
        className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4 dark:border-amber-900 dark:bg-amber-950/20">
        <h2 id="amux-idea-inbox-heading" className="flex items-center gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {m.inboxTitle}
          {waiting > 0 ? <span className="rounded-full border border-amber-300 px-2 text-xs font-medium text-amber-900 dark:border-amber-700 dark:text-amber-200">
            {m.inboxCount(waiting)}</span> : null}
        </h2>
        {waiting === 0 ? <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.inboxEmpty}</p> : (
          <ul className="space-y-2">
            {decisions.map((row) => (
              <li key={row.ideaId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-900 dark:bg-zinc-950">
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="font-semibold text-zinc-900 dark:text-zinc-100">
                    {decision[row.waitingFor as AmuxIdeaWaitingFor][0]}
                  </p>
                  <p className="text-zinc-800 dark:text-zinc-200">{label(row)} · {m.savedAt(when(row.submittedAt))}</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">
                    {decision[row.waitingFor as AmuxIdeaWaitingFor][1]}
                  </p>
                </div>
                <Link href={amuxIdeaHref(row.requestId)} onClick={keepDraft}
                  className="inline-flex min-h-11 items-center rounded-lg bg-blue-700 px-4 text-sm font-medium text-white dark:bg-blue-600">
                  {m.open}
                </Link>
              </li>
            ))}
            {reviews.map(({ row, pr }) => (
              <li key={`${row.ideaId}:${pr.number}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-white p-3 dark:border-amber-900 dark:bg-zinc-950">
                <div className="min-w-0 space-y-1 text-sm">
                  <p className="font-semibold text-zinc-900 dark:text-zinc-100">{m.githubReview}</p>
                  <p className="text-zinc-800 dark:text-zinc-200">PR #{pr.number} · {pr.displayKey ?? label(row)}</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-400">{m.githubReviewHint}</p>
                </div>
                <a href={`${REPOSITORY_URL}/pull/${pr.number}`} target="_blank" rel="noreferrer"
                  className="inline-flex min-h-11 items-center rounded-lg border border-blue-700 px-4 text-sm font-medium text-blue-800 dark:border-blue-400 dark:text-blue-200">
                  {m.reviewOnGithub} ↗
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="amux-idea-list-heading"
        className="space-y-3 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 id="amux-idea-list-heading" className="flex items-baseline justify-between gap-2 text-base font-semibold text-zinc-900 dark:text-zinc-100">
          {m.listTitle}
          {rows.length > 0 ? <span className="text-xs font-normal text-zinc-600 dark:text-zinc-400">{m.listCount(rows.length)}</span> : null}
        </h2>
        {rows.length === 0 ? <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.listEmpty}</p> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {rows.map((row) => {
              const step = amuxIdeaProgressStep(row.stage);
              const human = HUMAN_STAGES.has(row.stage);
              const active = row.requestId === activeRequestId;
              return (
                <li key={row.ideaId}>
                  <Link href={amuxIdeaHref(row.requestId)} onClick={keepDraft} aria-current={active ? "page" : undefined}
                    className={`block min-h-11 space-y-2 rounded-lg border p-3 text-sm ${active
                      ? "border-blue-500 ring-1 ring-blue-500" : "border-zinc-200 dark:border-zinc-800"}`}
                    data-testid="amux-idea-progress-row" data-stage={row.stage}>
                    <span className="block font-semibold text-zinc-900 dark:text-zinc-100">{label(row)}</span>
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded-full border px-2 py-0.5 ${row.attention
                        ? "border-red-300 text-red-800 dark:border-red-800 dark:text-red-200"
                        : human ? "border-amber-300 text-amber-900 dark:border-amber-700 dark:text-amber-200"
                          : "border-blue-200 text-blue-800 dark:border-blue-800 dark:text-blue-200"}`}>
                        {row.attention ? m.attention : m.stages[row.stage]}
                      </span>
                      <span className="text-zinc-600 dark:text-zinc-400">
                        {step ? m.stepOf(step) : null}{step ? " · " : ""}{human ? m.human : m.automatic}
                        {row.tasks.total > 0 ? ` · ${m.tasks(row.tasks.done, row.tasks.total)}` : ""}
                        {row.tasks.inReview > 0 ? ` · ${m.inReview(row.tasks.inReview)}` : ""}
                      </span>
                    </span>
                    {step ? (
                      <span className="grid grid-cols-6 gap-1" aria-hidden="true">
                        {Array.from({ length: 6 }, (_, index) => (
                          <span key={index} className={`h-1 rounded-full ${index < step - 1
                            ? "bg-blue-600 dark:bg-blue-400" : index === step - 1
                              ? (row.attention ? "bg-red-500" : human ? "bg-amber-500" : "bg-blue-400")
                              : "bg-zinc-200 dark:bg-zinc-800"}`} />
                        ))}
                      </span>
                    ) : null}
                    <span className="block text-xs text-zinc-500 dark:text-zinc-400">{m.savedAt(when(row.submittedAt))}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
