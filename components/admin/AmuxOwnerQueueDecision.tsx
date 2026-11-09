"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, CircleHelp, Eye, Wrench } from "lucide-react";

import {
  AmuxOwnerReviewDetail,
  AmuxPendingDecisionNotice,
  classifyAmuxOwnerQueueItem,
  visibleAmuxOwnerReviewOutcomes,
  type AmuxEscalationSummary,
  type AmuxOwnerReviewController,
} from "@/components/admin/AdminAmuxRoutingPanel";
import { useAdminLocale, useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { AmuxSettledCardEscalationPanel } from "@/components/admin/AmuxSettledCardEscalationPanel";
import { AmuxTaskQuestionSection } from "@/components/admin/AmuxWorkerQuestion";
import { AdminChannelIcon } from "@/components/admin/ui/AdminChannelIcon";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminIntlLocale } from "@/lib/adminLocale";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { adminAmuxOwnerQueueMessages } from "@/lib/adminMessages/amuxOwnerQueue";
import { adminAmuxRoutingMessages } from "@/lib/adminMessages/amuxRouting";
import { amuxElapsed } from "@/lib/adminAmuxFlow";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import { amuxReviewUsageOutcomeUnknown } from "@/lib/amux/ownerRecoveryCore";
import { isAmuxSettledCardWithOpenEscalation } from "@/lib/amux/settledCardEscalationCore";
import {
  amuxOwnerQueueGroup,
  type AmuxOwnerQueueGroup,
  type AmuxOwnerQueueItem,
} from "@/lib/amux/ownerQueueCore";

export const AMUX_OWNER_QUEUE_GROUP_TONE = {
  decide: "warn", question: "info", recover: "bad", read: "idle",
} as const satisfies Record<AmuxOwnerQueueGroup, "warn" | "info" | "bad" | "idle">;

const WHY_BOX_CLASS: Record<AmuxOwnerQueueGroup, string> = {
  decide: "border-amber-500/30 bg-amber-500/10",
  question: "border-blue-500/30 bg-blue-500/10",
  recover: "border-red-500/30 bg-red-500/10",
  read: "border-zinc-700 bg-zinc-800/60",
};

/** The one-line summary an escalation row needs for the existing queue classification. */
const summaryFor = (item: AmuxOwnerQueueItem): AmuxEscalationSummary | null =>
  item.escalationId === null ? null : {
    id: item.escalationId, specialty: null, reason_code: null, status: "open",
    createdAt: item.waitingSince,
    task: { id: item.taskId, title: item.title ?? "", sourceKey: item.sourceKey, priority: "", status: item.status },
  };

const EXCERPT_LINES = 6;
const EXCERPT_CHARS = 600;

/** The opening lines of a worker report, so a card with no pull request
 * shows what the worker said (tests run or not, PR opened or not) in the
 * "why" box. Whole lines, cut with an ellipsis; the full report stays below. */
export const workerReportExcerpt = (report: string | null) => {
  if (!report) return null;
  const lines = report.split(/\r?\n/).map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;
  const kept: string[] = [];
  let length = 0;
  for (const line of lines.slice(0, EXCERPT_LINES)) {
    if (kept.length > 0 && length + line.length + 1 > EXCERPT_CHARS) break;
    kept.push(line.length > EXCERPT_CHARS ? `${line.slice(0, EXCERPT_CHARS)}…` : line);
    length += line.length + 1;
  }
  return kept.length < lines.length ? `${kept.join("\n")}\n…` : kept.join("\n");
};

/** "N h" in the console's language, counted from the read time. */
export const useAmuxOwnerQueueElapsed = (generatedAt: string) => {
  const { locale } = useAdminLocale();
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  const nowMs = Date.parse(generatedAt);
  return (iso: string) => {
    const elapsed = amuxElapsed(Date.parse(iso), nowMs);
    return elapsed === null ? null : copy.list.ago(
      new Intl.NumberFormat(adminIntlLocale(locale), { style: "unit", unit: elapsed.unit, unitDisplay: "narrow" })
        .format(elapsed.value));
  };
};

/**
 * The right half of "Waiting on me": why the selected card stopped and the
 * decision for it, drawn from the existing parts. A worker question is the
 * existing answer box; an escalation is the existing protected owner review
 * (read, proposal, confirmation, step-up, "outcome unknown means no retry"),
 * which shows only the choices the server allows. This part adds an order and
 * words around them and writes nothing.
 */
export function AmuxOwnerQueueDecision({
  item, controller, canInspectCards, index, total, generatedAt, navLocked, advance,
  onAdvanceChange, onPrevious, onNext, onAnswered,
}: {
  item: AmuxOwnerQueueItem;
  controller: AmuxOwnerReviewController;
  /** The owner: reads worker questions and the card detail, inspects recovery. */
  canInspectCards: boolean;
  index: number;
  total: number;
  generatedAt: string;
  /** A decision is being read or recorded; leaving the card now is not offered. */
  navLocked: boolean;
  advance: boolean;
  onAdvanceChange: (advance: boolean) => void;
  onPrevious: (() => void) | null;
  onNext: (() => void) | null;
  onAnswered: () => void;
}) {
  const copy = useAdminMessages(adminAmuxOwnerQueueMessages);
  const execution = useAdminMessages(adminAmuxExecutionMessages);
  const routing = useAdminMessages(adminAmuxRoutingMessages);
  const elapsed = useAmuxOwnerQueueElapsed(generatedAt);
  const group = amuxOwnerQueueGroup(item);
  const reasonLabel = item.attentionReason === null ? null
    : execution.attentionReason[item.attentionReason] ?? execution.attentionReasonFallback;
  const summary = summaryFor(item);
  const review = controller.review;
  const reviewMatches = review !== null && summary !== null && review.escalation.id === summary.id;
  // Once this card's review is read, a finished run in review says whether it
  // has a pull request; until then the reason's own words make no PR claim.
  const reviewPr = reviewMatches && review.task.status === "review" &&
    item.attentionReason === "human_review_required" ? review.task.review_pr_number : undefined;
  const usageUnknown = reviewMatches && review.last_attempt !== null &&
    amuxReviewUsageOutcomeUnknown({ taskStatus: review.task.status,
      lastAttemptReason: review.review_context.last_attempt_reason,
      lastAttemptOutcome: review.last_attempt.outcome,
      lastAttemptToStatus: review.last_attempt.to_status,
      lastAttemptEndedAt: review.last_attempt.ended_at });
  const classification = summary === null ? null
    : classifyAmuxOwnerQueueItem(summary, reviewMatches ? review : null);
  const outcomes = reviewMatches ? visibleAmuxOwnerReviewOutcomes(review) : [];
  // The words follow the choices actually shown, not the PR alone: a verified
  // non-code Task is approved without one, and a spent budget, an unverified
  // result or pending publication leaves no retry.
  const noPrWhy = outcomes.includes("approve") ? copy.why.reviewNoPrApprovable
    : outcomes.includes("retry") ? copy.why.reviewNoPr : copy.why.reviewNoPrBlockOnly;
  // A blocked card's escalation keeps only execution_blocked; the attempt's
  // own reason, once the review is read, says what actually stopped it.
  const blockedAttemptReason = reviewMatches && review.task.status === "blocked" &&
    item.attentionReason === "execution_blocked" ?
    review.review_context.last_attempt_reason : null;
  const blockedWhy = blockedAttemptReason !== null &&
    Object.hasOwn(copy.why.byAttemptReason, blockedAttemptReason) ?
    copy.why.byAttemptReason[blockedAttemptReason] : null;
  const why = group === "question" ? copy.why.question
    : blockedWhy !== null ? blockedWhy
    : reviewPr === null ? noPrWhy
    : typeof reviewPr === "number" ? copy.why.reviewWithPr(reviewPr)
    : (item.attentionReason ? copy.why.byReason[item.attentionReason] : undefined) ?? copy.why[group];
  const reportExcerpt = reviewMatches && (reviewPr === null || blockedAttemptReason === "reported_result")
    ? workerReportExcerpt(review.review_report?.worker_report ?? null) : null;
  const showRecoverySteps = group !== "question" && summary !== null &&
    (group === "recover" || group === "read" || classification === "technical_recovery");
  const decisionOpen = classification === "owner_decision";
  const waiting = elapsed(item.waitingSince);

  return (
    <AdminTile data-testid="amux-owner-queue-decision" data-task-id={item.taskId} data-group={group}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-cyan-500/15 px-2 py-1 font-mono text-xs font-bold text-cyan-300"
          data-testid="amux-owner-queue-card-number">
          {amuxVisibleInspectionText(item.displayKey ?? item.taskId)}
        </span>
        <AdminStatusChip tone={AMUX_OWNER_QUEUE_GROUP_TONE[group]}>
          {reasonLabel ?? copy.group[group]}
        </AdminStatusChip>
        {waiting ? <span className="text-xs text-zinc-400">{waiting}</span> : null}
        {index > 0 ? (
          <span className="text-xs text-zinc-500" data-testid="amux-owner-queue-position">
            {copy.detail.position(index, total)}
          </span>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          {item.channel ? <AdminChannelIcon channel={item.channel} /> : null}
          <button type="button" onClick={onPrevious ?? undefined} disabled={navLocked || onPrevious === null}
            aria-label={copy.detail.previous} data-testid="amux-owner-queue-previous"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" onClick={onNext ?? undefined} disabled={navLocked || onNext === null}
            aria-label={copy.detail.next} data-testid="amux-owner-queue-next"
            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40">
            <ArrowRight className="h-4 w-4" aria-hidden />
          </button>
        </span>
      </div>

      <h2 className="break-words text-2xl font-black text-white" data-testid="amux-owner-queue-title">
        {item.title === null ? copy.list.untitled : amuxVisibleInspectionText(item.title)}
      </h2>

      <div className={`rounded-xl border p-4 ${WHY_BOX_CLASS[group]}`} data-testid="amux-owner-queue-why">
        <p className="flex items-center gap-2 text-sm font-bold text-zinc-100">
          {group === "question" ? <CircleHelp className="h-4 w-4" aria-hidden />
            : group === "read" ? <Eye className="h-4 w-4" aria-hidden />
            : <Wrench className="h-4 w-4" aria-hidden />}
          {copy.detail.whyStopped}
        </p>
        <p className="mt-1.5 text-sm leading-6 text-zinc-300">{why}</p>
        {usageUnknown && !outcomes.includes("approve") && !outcomes.includes("retry") ? (
          <p className="mt-1.5 text-sm leading-6 text-zinc-300" data-testid="amux-owner-queue-usage-unknown">
            {copy.why.reviewUsageUnknown}
          </p>
        ) : null}
        {reportExcerpt ? (
          <div className="mt-3" data-testid="amux-owner-queue-report-excerpt">
            <p className="text-xs font-bold text-zinc-400">{copy.detail.workerReportExcerpt}</p>
            <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-sm leading-6 text-zinc-200 [overflow-wrap:anywhere]">
              {reportExcerpt}
            </pre>
          </div>
        ) : null}
      </div>

      {group === "question" ? (
        <>
          {/* Reads and answers through the existing routes; only the owner may. */}
          <AmuxTaskQuestionSection key={item.taskId} taskId={item.taskId} canAnswer={canInspectCards}
            onAnswered={onAnswered} />
          {item.escalationId !== null
            ? <p className="text-xs leading-5 text-zinc-400">{copy.detail.questionAlso}</p> : null}
        </>
      ) : summary === null ? (
        <p className="rounded-xl border border-dashed border-zinc-700 p-4 text-sm text-zinc-300"
          data-testid="amux-owner-queue-no-review">
          {copy.detail.noReview}
        </p>
      ) : (
        <>
          {showRecoverySteps ? (
            <ol className="grid gap-3 sm:grid-cols-2" data-testid="amux-owner-queue-recovery-steps">
              <li className="flex flex-col gap-2 rounded-xl border border-zinc-700 bg-zinc-950/60 p-4">
                <p className="flex items-center gap-2 font-bold text-zinc-100">
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs text-white">1</span>
                  {copy.recovery.step1Title}
                </p>
                <p className="text-sm text-zinc-400">{copy.recovery.step1Detail}</p>
                <Link href="/admin/amux-recovery?tab=safety"
                  className="inline-flex min-h-9 w-fit items-center rounded-xl border border-zinc-700 px-3 text-xs font-bold text-zinc-100 hover:bg-zinc-800">
                  {copy.recovery.step1Link}
                </Link>
              </li>
              <li data-state={decisionOpen ? "open" : "locked"}
                className={`flex flex-col gap-2 rounded-xl border border-zinc-800 p-4 ${decisionOpen ? "bg-zinc-950/60" : "bg-zinc-900/60"}`}>
                <p className={`flex items-center gap-2 font-bold ${decisionOpen ? "text-zinc-100" : "text-zinc-500"}`}>
                  <span className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs ${decisionOpen ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400"}`}>
                    {decisionOpen ? <Check className="h-3.5 w-3.5" aria-hidden /> : 2}
                  </span>
                  {copy.recovery.step2Title}
                </p>
                <p className="text-sm text-zinc-400">
                  {decisionOpen ? copy.recovery.step2Open : copy.recovery.step2Locked}
                </p>
              </li>
              <li className="text-xs text-zinc-400 sm:col-span-2 list-none">{copy.recovery.note}</li>
            </ol>
          ) : null}

          <AmuxPendingDecisionNotice controller={controller} />

          {reviewMatches ? (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4" data-testid="amux-owner-queue-choices">
              <p className="text-sm font-bold text-zinc-100">
                {copy.detail.choices}
                <span className="ml-2 text-xs font-normal text-zinc-400">{copy.detail.choicesHint}</span>
              </p>
              {outcomes.length === 0 ? (
                <p className="mt-2 text-sm text-zinc-400">{copy.detail.choicesNone}</p>
              ) : (
                <>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {outcomes.map((outcome, position) => (
                      <li key={outcome} className="inline-flex items-center gap-2 rounded-xl border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200">
                        <kbd className="rounded bg-zinc-800 px-1.5 text-xs text-zinc-300">{position + 1}</kbd>
                        {routing.outcome[outcome]}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-zinc-500">{copy.detail.keyHint}</p>
                </>
              )}
            </div>
          ) : null}

          {/* The previous card's review stays in the controller until this card's read starts. */}
          {controller.selectedEscalationId === summary.id
            ? <AmuxOwnerReviewDetail controller={controller} showClose={false} />
            : <p role="status" className="text-sm text-zinc-400">{execution.loading}</p>}
        </>
      )}

      {/* A done or todo card whose earlier attempt left its escalation open
          has no review decision; the owner closes that escalation here. */}
      {canInspectCards && item.escalationId !== null && isAmuxSettledCardWithOpenEscalation(item) ? (
        <AmuxSettledCardEscalationPanel key={item.taskId + ":" + item.escalationId} taskId={item.taskId}
          escalationId={item.escalationId} canAct={canInspectCards}
          reauthReturnPath={`/admin/amux-execution?focusEscalation=${encodeURIComponent(item.escalationId)}`}
          onChanged={onAnswered} />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-3">
        <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-sm text-zinc-200">
          <input type="checkbox" checked={advance} onChange={(event) => onAdvanceChange(event.target.checked)}
            className="h-4 w-4 accent-blue-500" data-testid="amux-owner-queue-advance" />
          {copy.detail.advance}
        </label>
        {canInspectCards ? (
          <Link href={`/admin/amux-execution?tab=cards&taskId=${encodeURIComponent(item.taskId)}`}
            className="text-sm font-bold text-blue-300 underline-offset-2 hover:underline"
            data-testid="amux-owner-queue-full-detail">
            {copy.detail.fullDetail} →
          </Link>
        ) : (
          <span className="text-xs text-zinc-500">{copy.detail.fullDetailOwnerOnly}</span>
        )}
      </div>

      <AdminTechInfo>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt>{copy.detail.techInfoTask}</dt><dd className="break-all">{item.taskId}</dd>
          {item.sourceKey ? <><dt>{copy.detail.techInfoSource}</dt><dd className="break-all">{item.sourceKey}</dd></> : null}
          {item.escalationId ? <><dt>{copy.detail.techInfoEscalation}</dt><dd className="break-all">{item.escalationId}</dd></> : null}
        </dl>
      </AdminTechInfo>
    </AdminTile>
  );
}
