"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { amuxIdeaHasUnsavedDraft } from "@/lib/amux/ideaDraftGuard";
import { amuxIdeaProgressStep, type AmuxIdeaWaitingFor } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";

const REPOSITORY_URL = "https://github.com/mposition/Tomverse";
const BRISBANE = new Intl.DateTimeFormat("en-AU", {
  timeZone: "Australia/Brisbane", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  hour12: false,
});
const when = (iso: string) => BRISBANE.format(new Date(iso));
export const amuxIdeaHref = (requestId: string) =>
  `/admin/amux-backlog?${new URLSearchParams({ tab: "ideas", idea: requestId })}`;

/** null: the read failed; "reauthenticate": the owner's sign-in is not recent. */
export type AmuxIdeaProgressRows = AmuxIdeaProgressRow[] | null | "reauthenticate";

// The console is written in dark classes only; its Light theme remaps the
// palette (docs/ui-contracts/admin-console-ia.md, "The console theme"). A
// `dark:` variant would follow the product theme instead.
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";
const BUTTON_PRIMARY = `inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500 ${FOCUS}`;
const BUTTON_SECONDARY = `inline-flex min-h-11 items-center rounded-lg border border-zinc-600 px-4 text-sm font-medium text-zinc-100 hover:bg-zinc-800 ${FOCUS}`;

function useDraftGuard() {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  return (event: { preventDefault: () => void }) => {
    if (amuxIdeaHasUnsavedDraft() && !window.confirm(m.leaveDraft)) event.preventDefault();
  };
}

const label = (row: AmuxIdeaProgressRow, untitled: string) =>
  row.displayKey ?? `${untitled} ${row.requestId.slice(0, 8)}`;

/**
 * "Decide now" of the approved v49 backlog redesign: it lifts only the human
 * steps (execution approval, plan approval, a PR waiting for GitHub review).
 * A failed read is shown in this place as unavailable, never as an empty inbox.
 */
export function AmuxIdeaInbox({ rows }: { rows: AmuxIdeaProgressRows }) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const keepDraft = useDraftGuard();
  if (rows === "reauthenticate") {
    return <p role="status" className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-sm text-zinc-200"
      data-testid="amux-idea-progress-reauthenticate">
      {m.reauthenticate}{" "}
      <a className="font-medium text-blue-300 underline" href={adminRecentAuthenticationHref("/admin/amux-backlog?tab=ideas")}>{m.signIn}</a>
    </p>;
  }
  if (rows === null) {
    return <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200"
      data-testid="amux-idea-progress-unavailable">{m.unavailable}</p>;
  }
  const decisions = rows.filter((row) => row.waitingFor !== null);
  const decision: Record<AmuxIdeaWaitingFor, [string, string]> = {
    execution_approval: [m.executionApproval, m.executionApprovalHint],
    continuation: [m.continuationApproval, m.continuationHint],
    owner_input: [m.ownerInput, m.ownerInputHint],
    plan_approval: [m.planApproval, m.planApprovalHint],
    session_review: [m.sessionReview, m.sessionReviewHint],
  };
  const reviews = rows.flatMap((row) => row.reviewPullRequests.map((pr) => ({ row, pr })));
  const waiting = decisions.length + reviews.length;

  return (
    <section aria-labelledby="amux-idea-inbox-heading" data-testid="amux-idea-inbox"
      className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
      <h2 id="amux-idea-inbox-heading" className="flex items-center gap-2 text-base font-semibold text-zinc-100">
        {m.inboxTitle}
        {waiting > 0 ? <span className="rounded-full border border-amber-500/40 px-2 text-xs font-medium text-amber-200">
          {m.inboxCount(waiting)}</span> : null}
      </h2>
      {waiting === 0 ? <p className="text-sm text-zinc-300">{m.inboxEmpty}</p> : (
        <ul className="space-y-2">
          {decisions.map((row) => (
            <li key={row.ideaId} className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-zinc-900/60 p-3">
              <span aria-hidden="true" className="w-1 self-stretch rounded-full bg-amber-500" />
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <p className="font-semibold text-zinc-100">
                  {decision[row.waitingFor as AmuxIdeaWaitingFor][0]}
                </p>
                <p className="text-zinc-200">{label(row, m.untitled)} · {m.savedAt(when(row.submittedAt))}</p>
                <p className="text-xs text-zinc-400">
                  {decision[row.waitingFor as AmuxIdeaWaitingFor][1]}
                </p>
              </div>
              <Link href={amuxIdeaHref(row.requestId)} onClick={keepDraft} className={BUTTON_PRIMARY}>
                {m.open}
              </Link>
            </li>
          ))}
          {reviews.map(({ row, pr }) => (
            <li key={`${row.ideaId}:${pr.number}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-blue-500/30 bg-zinc-900/60 p-3">
              <span aria-hidden="true" className="w-1 self-stretch rounded-full bg-blue-500" />
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <p className="font-semibold text-zinc-100">{m.githubReview}</p>
                <p className="text-zinc-200">PR #{pr.number} · {pr.displayKey ?? label(row, m.untitled)}</p>
                <p className="text-xs text-zinc-400">{m.githubReviewHint}</p>
              </div>
              <a href={`${REPOSITORY_URL}/pull/${pr.number}`} target="_blank" rel="noreferrer" className={BUTTON_SECONDARY}>
                {m.reviewOnGithub} ↗
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "Ideas in progress": compact rows with the stage badge and the six-step
 * bar. It keeps its card when the read failed, so the page layout does not
 * move; the reason is stated once, in the inbox's place.
 */
export function AmuxIdeaList({ rows, activeRequestId, children }: {
  rows: AmuxIdeaProgressRows;
  activeRequestId: string | null;
  /** Controls that belong at the foot of this card (opening a saved request). */
  children?: ReactNode;
}) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const router = useRouter();
  const keepDraft = useDraftGuard();
  const list = Array.isArray(rows) ? rows : null;

  return (
    <section aria-labelledby="amux-idea-list-heading" data-testid="amux-idea-list"
      className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="amux-idea-list-heading" className="text-base font-semibold text-zinc-100">
          {m.listTitle}
          {list && list.length > 0 ? <span className="ml-2 text-xs font-normal text-zinc-400">{m.listCount(list.length)}</span> : null}
        </h2>
        {/* A server read: saving or approving below changes it, so it can be read again. */}
        <button type="button" onClick={() => router.refresh()}
          className={`min-h-11 rounded-lg border border-zinc-600 px-3 text-sm text-zinc-100 hover:bg-zinc-800 ${FOCUS}`}>
          {m.refresh}
        </button>
      </div>
      {list === null ? <p className="text-sm text-zinc-400" data-testid="amux-idea-list-unavailable">{m.listUnavailable}</p>
        : list.length === 0 ? <p className="text-sm text-zinc-300">{m.listEmpty}</p> : (
          <ul className="grid gap-2">
            {list.map((row) => {
              const step = amuxIdeaProgressStep(row.stage);
              // A person acts when a decision waits, or a PR waits for GitHub review.
              const human = row.waitingFor !== null || row.tasks.inReview > 0;
              const active = row.requestId === activeRequestId;
              return (
                <li key={row.ideaId}>
                  <Link href={amuxIdeaHref(row.requestId)} onClick={keepDraft} aria-current={active ? "page" : undefined}
                    className={`block min-h-11 space-y-2 rounded-lg border p-3 text-sm hover:bg-zinc-800/60 ${FOCUS} ${active
                      ? "border-blue-400 ring-1 ring-blue-400" : "border-zinc-800"}`}
                    data-testid="amux-idea-progress-row" data-stage={row.stage}>
                    <span className="block font-semibold text-zinc-100">{label(row, m.untitled)}</span>
                    <span className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded-full border px-2 py-0.5 ${row.attention
                        ? "border-red-500/40 bg-red-500/10 text-red-200"
                        : human ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                          : "border-blue-500/40 bg-blue-500/10 text-blue-200"}`}>
                        {row.attention ? m.attention : m.stages[row.stage]}
                      </span>
                      <span className="text-zinc-400">
                        {step ? m.stepOf(step) : null}{step ? " · " : ""}{human ? m.human : m.automatic}
                        {row.tasks.total > 0 ? ` · ${m.tasks(row.tasks.done, row.tasks.total)}` : ""}
                        {row.tasks.inReview > 0 ? ` · ${m.inReview(row.tasks.inReview)}` : ""}
                      </span>
                    </span>
                    {step ? (
                      <span className="grid grid-cols-6 gap-1" aria-hidden="true">
                        {Array.from({ length: 6 }, (_, index) => (
                          <span key={index} className={`h-1 rounded-full ${index < step - 1
                            ? "bg-blue-500" : index === step - 1
                              ? (row.attention ? "bg-red-500" : human ? "bg-amber-500" : "bg-blue-300")
                              : "bg-zinc-800"}`} />
                        ))}
                      </span>
                    ) : null}
                    <span className="block text-xs text-zinc-400">{m.savedAt(when(row.submittedAt))}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      {children}
    </section>
  );
}

/**
 * The inbox and the list one above the other, for the page that is showing an
 * opened idea (its flow leads; this follows it). The Ideas main places the two
 * parts itself, beside the input.
 */
export function AmuxIdeaProgressPanel({ rows, activeRequestId }: {
  rows: AmuxIdeaProgressRows;
  activeRequestId: string | null;
}) {
  return (
    <div className="flex flex-col gap-5" data-testid="amux-idea-progress">
      <AmuxIdeaInbox rows={rows} />
      <AmuxIdeaList rows={rows} activeRequestId={activeRequestId} />
    </div>
  );
}
