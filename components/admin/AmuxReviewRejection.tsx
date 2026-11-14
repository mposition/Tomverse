"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import { amuxV52RejectionView } from "@/lib/amux/v52ReviewFindingsCore";

export type AmuxRejectedAttempt = {
  id: string;
  attemptNumber: number | null;
  v52Review?: unknown;
};

/**
 * The attempts whose v52 review rejected the run, newest first as the card
 * detail lists them. Anything the detail answer does not carry as an attempt
 * with a reject is left out.
 */
export function amuxRejectedAttemptsOf(taskId: string, body: unknown): AmuxRejectedAttempt[] {
  if (typeof body !== "object" || body === null) return [];
  const detail = body as Record<string, unknown>;
  if (detail.id !== taskId || !Array.isArray(detail.attempts)) return [];
  return detail.attempts.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const attempt = value as Record<string, unknown>;
    if (typeof attempt.id !== "string" || amuxV52RejectionView(attempt.v52Review) === null) return [];
    return [{ id: attempt.id,
      attemptNumber: Number.isSafeInteger(attempt.attemptNumber) ? attempt.attemptNumber as number : null,
      v52Review: attempt.v52Review }];
  });
}

/** One rejected run's reasons, or where to read them for an older record. */
export function AmuxReviewRejectionReason({ review, attemptNumber, showAttempt = false }: {
  review: unknown;
  attemptNumber: number | null;
  showAttempt?: boolean;
}) {
  const m = useAdminMessages(adminAmuxExecutionMessages).reviewRejection;
  const view = amuxV52RejectionView(review);
  if (view === null) return null;
  const vendors = view.reviewerVendors.map(amuxVisibleInspectionText).join(", ");
  return (
    <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/5 p-2 text-sm"
      data-testid="amux-review-rejection" data-kind={view.kind}>
      <p className="text-xs font-bold text-red-200">
        {showAttempt ? `${m.attempt(attemptNumber)} · ` : ""}{m.title}
        {vendors ? <span className="ml-1 font-normal text-zinc-400">({m.reviewers(vendors)})</span> : null}
      </p>
      {view.kind === "summary" ? (
        <>
          <ul className="mt-1 space-y-0.5 break-words text-zinc-200 [overflow-wrap:anywhere]"
            data-testid="amux-review-rejection-lines">
            {view.lines.map((line, index) => <li key={index}>{amuxVisibleInspectionText(line)}</li>)}
          </ul>
          <p className="mt-1 text-xs text-zinc-500">{m.untrusted}</p>
        </>
      ) : view.kind === "job" ? (
        <div className="mt-1 text-zinc-300">
          <p>{m.noSummary(view.jobId)}</p>
          <p className="mt-1 text-xs text-zinc-400">{m.noSummaryCommand}</p>
          <code className="mt-0.5 block break-all font-mono text-xs text-zinc-200"
            data-testid="amux-review-rejection-command">
            npm run -s review -- report {view.jobId} --slot 0
          </code>
        </div>
      ) : (
        <p className="mt-1 text-zinc-400">{m.noJob}</p>
      )}
    </div>
  );
}

/** Every rejected run of the card, for the owner queue's decision. */
export function AmuxReviewRejectionList({ attempts }: { attempts: AmuxRejectedAttempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <div data-testid="amux-review-rejection-list">
      {attempts.map((attempt) => (
        <AmuxReviewRejectionReason key={attempt.id} review={attempt.v52Review}
          attemptNumber={attempt.attemptNumber} showAttempt />
      ))}
    </div>
  );
}
