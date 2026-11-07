"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxIdeaClosePanel } from "@/components/admin/AmuxIdeaClosePanel";
import { AdminStepper } from "@/components/admin/ui/AdminStepper";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { amuxIdeaFlowSteps } from "@/lib/adminAmuxFlow";
import { adminAmuxIdeaProgressMessages } from "@/lib/adminMessages/amuxIdeaProgress";
import { adminAmuxScreensMessages } from "@/lib/adminMessages/amuxScreens";
import { adminRecentAuthenticationHref } from "@/lib/adminReauthenticationCore";
import { amuxIdeaHasUnsavedDraft } from "@/lib/amux/ideaDraftGuard";
import { AMUX_IDEA_LANE_MAX_ATTEMPTS } from "@/lib/amux/ideaLaneCore";
import type { AmuxIdeaWaitingFor } from "@/lib/amux/ideaProgressCore";
import type { AmuxIdeaProgressRow } from "@/lib/amux/ideaProgressRead";
import { amuxIdeaName, amuxIdeaNameText } from "@/lib/amux/ideaTitleCore";

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
// palette (docs/ui-contracts/admin-console-ia.md, "The console theme"). A dark
// variant prefix would follow the product theme instead.
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-300";
const BUTTON_PRIMARY = `inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500 ${FOCUS}`;
const BUTTON_SECONDARY = `inline-flex min-h-11 items-center rounded-lg border border-zinc-600 px-4 text-sm font-medium text-zinc-100 hover:bg-zinc-800 ${FOCUS}`;

function useDraftGuard() {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  return (event: { preventDefault: () => void }) => {
    if (amuxIdeaHasUnsavedDraft() && !window.confirm(m.leaveDraft)) event.preventDefault();
  };
}

const label = amuxIdeaNameText;

/** An idea's name: card display key, else its title with the short id small beside it, else the id. */
export function AmuxIdeaName({ row, untitled }: {
  row: Pick<AmuxIdeaProgressRow, "displayKey" | "title" | "requestId">; untitled: string;
}) {
  const name = amuxIdeaName(row, untitled);
  return <>
    {name.primary}
    {name.shortId ? <>{" "}<span className="font-mono text-xs font-normal text-zinc-400"
      data-testid="amux-idea-short-id">{name.shortId}</span></> : null}
  </>;
}

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
  // Nothing moves a blocked idea on until someone looks at it (its detail says where).
  const blocked = rows.filter((row) => !row.lane && row.stage === "execution" && row.activity === "blocked");
  const waiting = decisions.length + reviews.length + blocked.length;

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
                <p className="text-zinc-200"><AmuxIdeaName row={row} untitled={m.untitled} /> · {m.savedAt(when(row.submittedAt))}</p>
                <p className="text-xs text-zinc-400">
                  {decision[row.waitingFor as AmuxIdeaWaitingFor][1]}
                </p>
              </div>
              <Link href={amuxIdeaHref(row.requestId)} onClick={keepDraft} className={BUTTON_PRIMARY}>
                {m.open}
              </Link>
            </li>
          ))}
          {blocked.map((row) => (
            <li key={`${row.ideaId}:blocked`} className="flex flex-wrap items-center gap-3 rounded-lg border border-red-500/30 bg-zinc-900/60 p-3"
              data-testid="amux-idea-inbox-blocked">
              <span aria-hidden="true" className="w-1 self-stretch rounded-full bg-red-500" />
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <p className="font-semibold text-zinc-100">{m.executionBlocked}</p>
                <p className="text-zinc-200"><AmuxIdeaName row={row} untitled={m.untitled} /> · {m.savedAt(when(row.submittedAt))}</p>
                <p className="text-xs text-zinc-400">{m.executionBlockedHint}</p>
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
                <p className="text-zinc-200">PR #{pr.number} · {pr.displayKey ?? <AmuxIdeaName row={row} untitled={m.untitled} />}</p>
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
 * "Ideas in progress": one card per idea with the five-step bar (idea,
 * execution approval, plan approval, run, PR). Ideas that wait for a person
 * come first and carry the decision as their cue; the row still only links to
 * the idea, where the existing approval panels are. It keeps its card when the
 * read failed, so the page layout does not move; the reason is stated once, in
 * the inbox's place. Ideas waiting for the owner after analysis can be ticked
 * and closed together.
 */
export function AmuxIdeaList({ rows, activeRequestId, children }: {
  rows: AmuxIdeaProgressRows;
  activeRequestId: string | null;
  /** Controls that belong at the foot of this card (opening a saved request). */
  children?: ReactNode;
}) {
  const m = useAdminMessages(adminAmuxIdeaProgressMessages);
  const screens = useAdminMessages(adminAmuxScreensMessages).ideas;
  const router = useRouter();
  const keepDraft = useDraftGuard();
  const list = Array.isArray(rows) ? rows : null;
  const closable = (list ?? []).filter((row) => row.closable);
  const [picked, setPicked] = useState<string[]>([]);
  // Kept after a close so its per-idea results stay readable once the rows refresh.
  const [closeSent, setCloseSent] = useState(false);
  // A refreshed list drops ideas that are no longer closable from the selection.
  const selected = picked.filter((id) => closable.some((row) => row.ideaId === id));
  const toggle = (ideaId: string) => setPicked((current) => current.includes(ideaId)
    ? current.filter((id) => id !== ideaId) : [...current, ideaId]);
  const labelFor = (ideaId: string) => {
    const row = list?.find((entry) => entry.ideaId === ideaId);
    return row ? label(row, m.untitled) : `${m.untitled} ${ideaId.slice(0, 8)}`;
  };
  // What waits for a person comes first; the server's order is kept inside each group.
  const decisionTitle = (waitingFor: AmuxIdeaWaitingFor) => ({
    execution_approval: m.executionApproval, continuation: m.continuationApproval,
    owner_input: m.ownerInput, plan_approval: m.planApproval, session_review: m.sessionReview,
  })[waitingFor];
  const ordered = list === null ? [] : [
    ...list.filter((row) => row.waitingFor !== null || row.tasks.inReview > 0),
    ...list.filter((row) => !(row.waitingFor !== null || row.tasks.inReview > 0)),
  ];

  return (
    <AdminTile as="section" aria-label={m.listTitle} data-testid="amux-idea-list"
      title={<>{m.listTitle}{list && list.length > 0
        ? <span className="ml-2 text-xs font-normal text-zinc-400">{m.listCount(list.length)}</span> : null}</>}
      description={screens.listLede}
      action={
        // A server read: saving or approving below changes it, so it can be read again.
        <button type="button" onClick={() => router.refresh()}
          className={`min-h-11 rounded-xl border border-zinc-700 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-800 ${FOCUS}`}>
          {m.refresh}
        </button>}>
      {list === null ? <p className="text-sm text-zinc-400" data-testid="amux-idea-list-unavailable">{m.listUnavailable}</p>
        : list.length === 0 ? <p className="text-sm text-zinc-300">{m.listEmpty}</p> : (
          <ul className="grid gap-3">
            {ordered.map((row) => {
              const flow = amuxIdeaFlowSteps(row.stage, { attention: row.attention || row.activity === "blocked" });
              // A person acts when a decision waits, or a PR waits for GitHub review.
              const human = row.waitingFor !== null || row.tasks.inReview > 0;
              const stopped = row.attention || row.activity === "blocked";
              const active = row.requestId === activeRequestId;
              return (
                <li key={row.ideaId} className="flex items-stretch gap-2">
                  {closable.length > 0 ? (
                    <label className="flex min-h-11 w-8 shrink-0 items-start justify-center pt-4">
                      {row.closable ? <input type="checkbox" checked={selected.includes(row.ideaId)}
                        onChange={() => toggle(row.ideaId)} aria-label={m.close.select(label(row, m.untitled))}
                        data-testid="amux-idea-close-select" className={`h-5 w-5 ${FOCUS}`} /> : null}
                    </label>
                  ) : null}
                  <Link href={amuxIdeaHref(row.requestId)} onClick={keepDraft} aria-current={active ? "page" : undefined}
                    className={`block min-h-11 min-w-0 flex-1 space-y-3 rounded-2xl border p-4 text-sm hover:bg-zinc-800/60 ${FOCUS} ${active
                      ? "ring-2 ring-blue-400" : ""} ${stopped ? "border-red-500/50 bg-red-500/5"
                      : human ? "border-blue-500/60 bg-blue-500/10" : "border-zinc-800 bg-zinc-900"}`}
                    data-testid="amux-idea-progress-row" data-stage={row.stage} data-decision={human ? "true" : undefined}>
                    <span className="flex flex-wrap items-start justify-between gap-2">
                      <span className="min-w-0 font-bold text-zinc-100"><AmuxIdeaName row={row} untitled={m.untitled} /></span>
                      {human ? (
                        <span className="inline-flex min-h-8 items-center rounded-xl bg-blue-600 px-3 text-xs font-bold text-white"
                          data-testid="amux-idea-decision-cue">
                          {row.waitingFor !== null ? decisionTitle(row.waitingFor) : m.githubReview}
                        </span>
                      ) : (
                        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${stopped
                          ? "bg-red-500/15 text-red-300" : "bg-blue-500/15 text-blue-300"}`}>
                          {row.attention ? (row.lane ? (row.lane.state === "pr_closed" ? m.lane.badgePrClosed : m.lane.badgeFailed)
                            : m.attention) : m.stages[row.stage]}
                        </span>
                      )}
                    </span>
                    {flow ? (
                      <AdminStepper label={screens.flow.label} stateWords={screens.flow.states}
                        steps={flow.map((step) => ({ ...step, label: screens.flow.steps[step.id] }))}
                        data-testid="amux-idea-flow" />
                    ) : null}
                    <span className="block text-xs text-zinc-400">
                      {human ? m.human : row.activity ? m.activity[row.activity] : m.automatic}
                      {row.tasks.total > 0 ? ` · ${m.tasks(row.tasks.done, row.tasks.total)}` : ""}
                      {row.tasks.inReview > 0 ? ` · ${m.inReview(row.tasks.inReview)}` : ""}
                      {` · ${m.stages[row.stage]}`}
                    </span>
                    {row.lane ? (
                      <span className="block text-xs text-zinc-300" data-testid="amux-idea-lane">{laneLine(row.lane, m)}</span>
                    ) : null}
                    <span className="block text-xs text-zinc-500">{m.savedAt(when(row.submittedAt))}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      {closable.length > 0 || closeSent ? (
        <AmuxIdeaClosePanel mode="selection" ideaIds={selected} labelFor={labelFor}
          onSelectAll={() => setPicked(closable.map((row) => row.ideaId))}
          onClear={() => setPicked([])} onSent={() => setCloseSent(true)} />
      ) : null}
      {children}
    </AdminTile>
  );
}

/** One line for an idea the lane took or will take next (lib/amux/ideaLaneCore.ts). */
export function laneLine(lane: NonNullable<AmuxIdeaProgressRow["lane"]>, m: { lane: {
  running: (attempt: number, max: number) => string;
  waiting: string;
  queued: (attempts: number, max: number, outcome: string) => string;
  prOpen: (pr: number) => string;
  merged: (pr: number) => string;
  prClosed: (pr: number) => string;
  failed: (max: number, outcome: string) => string;
  part: (part: number) => string;
  continuesAfterMerge: string;
  nextPartWaiting: (pr: number) => string;
} }): string {
  const line = laneStateLine(lane, m);
  // A larger idea runs in parts, each after the one before merged. A part's
  // PR closed without a merge stops the chain, so only an open one promises more.
  const parted = lane.part > 1 || lane.continues ? `${m.lane.part(lane.part)} · ${line}` : line;
  return lane.continues && lane.state === "pr_open" ? `${parted} · ${m.lane.continuesAfterMerge}` : parted;
}

function laneStateLine(lane: NonNullable<AmuxIdeaProgressRow["lane"]>, m: Parameters<typeof laneLine>[1]): string {
  const max = AMUX_IDEA_LANE_MAX_ATTEMPTS;
  const last = lane.lastOutcome ?? "-";
  if (lane.state === "merged" && lane.prNumber !== null) return m.lane.merged(lane.prNumber);
  if (lane.state === "pr_closed" && lane.prNumber !== null) return m.lane.prClosed(lane.prNumber);
  if (lane.state === "pr_open" && lane.prNumber !== null) return m.lane.prOpen(lane.prNumber);
  if (lane.state === "running") return m.lane.running(lane.attempts, max);
  if (lane.state === "queued" && lane.attempts === 0 && lane.previousPrNumber !== null) {
    return m.lane.nextPartWaiting(lane.previousPrNumber);
  }
  if (lane.state === "queued" && lane.attempts === 0) return m.lane.waiting;
  if (lane.state === "queued") return m.lane.queued(lane.attempts, max, last);
  return m.lane.failed(max, last);
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
