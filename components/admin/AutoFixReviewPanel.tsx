"use client";

import { formatAestDateTime, type AdminTone } from "@/lib/adminUiCore";
import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import {
  TraceAnalysisBlock,
  feedbackFirstLine,
  type FeedbackRow,
} from "@/components/admin/FeedbackInboxPanel";
import { AdminStateBlock } from "@/components/admin/ui/AdminStateBlock";
import { AdminStatusChip } from "@/components/admin/ui/AdminStatusChip";
import { AdminTechInfo } from "@/components/admin/ui/AdminTechInfo";
import { AdminTile } from "@/components/admin/ui/AdminTile";
import { adminFeedbackInboxMessages } from "@/lib/adminMessages/feedbackInbox";

/** Why a report's case is in front of a person. */
export type AutoFixWaitingKind = "awaiting_human_review" | "prOpen" | "handedOff";

/**
 * Whether a report's fix is waiting for a person, read from the case the
 * inquiries already carry -- no new read. A draft PR the lane recorded as open
 * is the plainest case; a fix handed to the lane but not yet a PR is next; and
 * a case the deterministic rules passed to human review (policy
 * `docs/policy/trace-feedback-automation.md §8`, `awaiting_human_review`) is the rest. Anything
 * else is still being worked on by the automation or was judged not fixable by
 * code, so nobody is waiting on it.
 */
export const autoFixWaitingKind = (row: FeedbackRow): AutoFixWaitingKind | null => {
  const fixCase = row.autoFixCase;
  if (!fixCase) return null;
  if (fixCase.analysis?.status === "done") {
    if (fixCase.analysis.prNumber) return "prOpen";
    if (fixCase.analysis.handedOff) return "handedOff";
  }
  return fixCase.state === "awaiting_human_review" ? "awaiting_human_review" : null;
};

const WAITING_TONE: Record<AutoFixWaitingKind, AdminTone> = {
  awaiting_human_review: "warn",
  prOpen: "info",
  handedOff: "info",
};

const dateLabel = (value: string) => formatAestDateTime(value) ?? "-";

/**
 * Fixes the automation proposed from verified reports, waiting for a person.
 * Read only: the page already reads the newest reports for the inquiries tab,
 * and this is the same rows seen by their case. Nothing here runs or approves a
 * fix; a draft PR is merged on GitHub, by a person.
 */
export function AutoFixReviewPanel({ rows, rowLimit }: { rows: FeedbackRow[]; rowLimit: number }) {
  const m = useAdminMessages(adminFeedbackInboxMessages);
  const waiting = rows.flatMap((row) => {
    const kind = autoFixWaitingKind(row);
    return kind ? [{ row, kind }] : [];
  });
  const others = rows.filter((row) => row.autoFixCase && !autoFixWaitingKind(row));
  const statusText = (status: string) => (m.statuses as Record<string, string>)[status] ?? status;

  return (
    <div className="flex min-w-0 flex-col gap-5" data-testid="autofix-review">
      <AdminTile
        title={m.autoFix.title}
        description={`${m.autoFix.description} ${m.autoFix.scope(rowLimit)}`}
      >
        {waiting.length === 0 ? (
          <div data-testid="autofix-review-empty">
            <AdminStateBlock
              kind="empty"
              title={m.autoFix.emptyTitle}
              detail={m.autoFix.emptyDetail(rowLimit)}
            />
          </div>
        ) : (
          <ul className="flex min-w-0 flex-col">
            {waiting.map(({ row, kind }) => {
              const fixCase = row.autoFixCase!;
              return (
                <li
                  key={row.id}
                  data-testid="autofix-review-row"
                  data-feedback-id={row.id}
                  className="flex min-w-0 flex-col gap-2 border-t border-zinc-800 py-4 first:border-t-0 first:pt-0"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <AdminStatusChip tone={WAITING_TONE[kind]}>{m.autoFix.states[kind]}</AdminStatusChip>
                    <AdminStatusChip tone="idle">
                      {fixCase.classification
                        ? ((m.autoFix.classifications as Record<string, string>)[fixCase.classification] ??
                          fixCase.classification)
                        : m.autoFix.noClassification}
                    </AdminStatusChip>
                    <span className="text-xs text-zinc-500">
                      {m.autoFix.reportStatus(statusText(row.status))}
                    </span>
                    <span className="whitespace-nowrap text-xs text-zinc-500">
                      {m.autoFix.updated(dateLabel(fixCase.updatedAt))}
                    </span>
                  </div>
                  <p className="truncate text-sm font-bold text-zinc-100">
                    {feedbackFirstLine(row.message) || "-"}
                  </p>
                  {fixCase.ineligibilityReason ? (
                    <p className="text-xs text-zinc-400 [overflow-wrap:anywhere]">
                      {m.autoFix.reason(fixCase.ineligibilityReason)}
                    </p>
                  ) : null}
                  {fixCase.analysis ? <TraceAnalysisBlock analysis={fixCase.analysis} m={m} /> : null}
                  <a
                    href={`/admin/support?tab=feedback&q=${encodeURIComponent(row.id)}`}
                    className="self-start text-sm font-bold text-blue-300 underline-offset-2 hover:underline"
                  >
                    {m.autoFix.openInquiry}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-xs text-zinc-500">{m.autoFix.readOnly}</p>
      </AdminTile>

      {others.length > 0 ? (
        <AdminTechInfo summary={m.autoFix.othersSummary(others.length)}>
          <p className="mb-3 font-sans text-zinc-400">{m.autoFix.othersHint}</p>
          <ul className="flex flex-col gap-2 [overflow-wrap:anywhere]">
            {others.map((row) => {
              const fixCase = row.autoFixCase!;
              return (
                <li key={row.id} data-testid="autofix-review-other" className="border-t border-zinc-800 pt-2 first:border-t-0 first:pt-0">
                  <span>{row.id.slice(0, 10)}</span>
                  {" · "}
                  <span>{m.autoFix.caseStates[fixCase.state] ?? fixCase.state}</span>
                  {" · "}
                  <span>
                    {fixCase.classification
                      ? (m.autoFix.classifications[fixCase.classification] ?? fixCase.classification)
                      : m.autoFix.noClassification}
                  </span>
                  {fixCase.ineligibilityReason ? <span>{` · ${fixCase.ineligibilityReason}`}</span> : null}
                  {" · "}
                  <span>{dateLabel(fixCase.updatedAt)}</span>
                </li>
              );
            })}
          </ul>
        </AdminTechInfo>
      ) : null}
    </div>
  );
}
