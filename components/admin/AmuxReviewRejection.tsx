"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxExecutionMessages } from "@/lib/adminMessages/amuxExecution";
import { amuxVisibleInspectionText } from "@/lib/amux/adminExecutionViewCore";
import { amuxV52RejectionView, amuxV52SortedFindings } from "@/lib/amux/v52ReviewFindingsCore";

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
      {view.kind === "findings" ? (
        <>
          <ul className="mt-1 space-y-1 break-words text-zinc-200 [overflow-wrap:anywhere]"
            data-testid="amux-review-rejection-findings">
            {amuxV52SortedFindings(view.doc).map(({ finding, vendor }, index) => (
              <li key={index} data-severity={finding.severity}>
                <span className="text-xs font-bold uppercase text-red-200">{finding.severity}</span>
                {vendor ? <span className="ml-1 text-xs text-zinc-400">{amuxVisibleInspectionText(vendor)}</span> : null}
                {finding.file ? (
                  <code className="ml-1 font-mono text-xs text-zinc-300">
                    {amuxVisibleInspectionText(finding.file)}{finding.line ? `:${finding.line}` : ""}
                  </code>
                ) : null}
                <span className="ml-1 whitespace-pre-wrap">{amuxVisibleInspectionText(finding.summary)}</span>
              </li>
            ))}
          </ul>
          {/* A reviewer that rejected without listing a finding: its reason and what its report said. */}
          {view.doc.reviewers.filter((reviewer) => reviewer.verdict !== "accept" && reviewer.findings.length === 0)
            .map((reviewer, index) => (
              <div key={index} className="mt-1 text-zinc-200" data-testid="amux-review-rejection-no-finding">
                <p className="text-xs text-zinc-400">
                  {m.noFinding(reviewer.vendor ? amuxVisibleInspectionText(reviewer.vendor) : null, reviewer.reason)}
                </p>
                {reviewer.note ? (
                  <ul className="mt-0.5 space-y-0.5 break-words [overflow-wrap:anywhere]">
                    {reviewer.note.split("\n").map((line, lineIndex) => (
                      <li key={lineIndex}>{amuxVisibleInspectionText(line)}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          {view.doc.reviewers.some((reviewer) => reviewer.omitted > 0) ? (
            <p className="mt-1 text-xs text-zinc-400" data-testid="amux-review-rejection-omitted">
              {m.omitted(view.doc.reviewers.reduce((sum, reviewer) => sum + reviewer.omitted, 0))}
            </p>
          ) : null}
          <p className="mt-1 text-xs text-zinc-500">{m.untrusted}</p>
        </>
      ) : view.kind === "purged" || view.kind === "unreadable" ? (
        <div className="mt-1 text-zinc-300" data-testid="amux-review-rejection-unavailable">
          <p>{view.kind === "purged" ? m.purged : m.unreadable}</p>
          {view.jobId ? <p className="mt-1 text-xs text-zinc-400">{m.jobHint(view.jobId)}</p> : null}
        </div>
      ) : view.kind === "summary" ? (
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
          {/* A contract change has two reviewers; either slot may hold the reject. */}
          {Array.from({ length: Math.max(1, view.reviewerVendors.length) }, (_, slot) => (
            <code key={slot} className="mt-0.5 block break-all font-mono text-xs text-zinc-200"
              data-testid="amux-review-rejection-command">
              npm run -s review -- report {view.jobId} --slot {slot}
            </code>
          ))}
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
