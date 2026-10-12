"use client";

import { useAdminMessages } from "@/components/admin/AdminLocaleProvider";
import { adminAmuxDecisionMakerReportMessages } from "@/lib/adminMessages/amuxDecisionMaker";
import type {
  DmDeclarationAccuracyInstanceReport,
  DmDeclarationAccuracyReport,
  DmReportMetric,
} from "@/lib/amux/decisionMakerJudgmentCore";

type Messages = (typeof adminAmuxDecisionMakerReportMessages)["en"];

/** A database-clock instant to the minute, in UTC, as the ledger stores it. */
export const dmReportInstant = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * A rate as its numerator over its denominator with the share beside it, or
 * the words for an empty denominator -- never `0%`, which would be a claim
 * the ledger cannot make (docs/policy/amux-decision-maker.md §4:
 * "분모가 비면 `insufficient_evidence`다").
 */
export const dmReportMetricText = (m: Messages, metric: DmReportMetric) =>
  metric.status === "insufficient_evidence"
    ? m.insufficientEvidence
    : `${metric.numerator} / ${metric.denominator} (${(metric.value * 100).toFixed(1)}%)`;

const daysText = (m: Messages, entry: DmDeclarationAccuracyInstanceReport) =>
  entry.daysSinceFirstProposal.status === "insufficient_evidence"
    ? m.noProposal
    : m.days(entry.daysSinceFirstProposal.days, dmReportInstant(entry.daysSinceFirstProposal.firstProposalAtMs));

const ROWS = [
  "decidedProposals",
  "daysSinceFirstProposal",
  "confirmedWithoutEdit",
  "matchedOverJudged",
  "notJudged",
] as const;

const cellText = (m: Messages, entry: DmDeclarationAccuracyInstanceReport, row: (typeof ROWS)[number]) =>
  row === "daysSinceFirstProposal" ? daysText(m, entry) : dmReportMetricText(m, entry[row]);

const cellClass = "border-b border-zinc-200 px-2 py-2 align-top dark:border-zinc-700";

/**
 * AMUX › Execution › Decision Maker, §4's declaration accuracy report, without
 * hooks, so a test can call it and read the tree it returns.
 *
 * `report` is what the page read, or `null` when the read failed: then the
 * panel says so and shows no figure. It offers no control. The report is a
 * value; nothing here compares it with a graduation criterion or changes a
 * switch (§4: "보고는 스위치·모드를 바꾸지 않고, 졸업을 기록하지 않으며,
 * 자율을 허락하지 않는다").
 */
export function AmuxDecisionMakerReportView({
  m,
  report,
}: {
  m: Messages;
  report: DmDeclarationAccuracyReport | null;
}) {
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4"
      data-testid="amux-decision-maker-report-panel"
    >
      <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{m.title}</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.description}</p>
      <p className="text-sm text-zinc-700 dark:text-zinc-300">{m.noEffect}</p>
      {report === null ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300" data-testid="amux-dm-report-unavailable">
          {m.unavailable}
        </p>
      ) : (
        <>
          <p className="text-xs text-zinc-600 dark:text-zinc-400" data-testid="amux-dm-report-computed-at">
            {m.computedAt(dmReportInstant(report.dbNowMs))}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm text-zinc-900 dark:text-zinc-100">
              <thead>
                <tr>
                  <th scope="col" className={`${cellClass} font-medium`}>
                    {m.measure}
                  </th>
                  {report.instances.map((entry) => (
                    <th key={entry.instance} scope="col" className={`${cellClass} font-medium`}>
                      {entry.instance}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row} data-testid={`amux-dm-report-${row}`}>
                    <th scope="row" className={`${cellClass} font-medium`}>
                      {m[row]}
                    </th>
                    {report.instances.map((entry) => (
                      <td
                        key={entry.instance}
                        className={cellClass}
                        data-testid={`amux-dm-report-${row}-${entry.instance}`}
                      >
                        {cellText(m, entry, row)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function AmuxDecisionMakerReportPanel({ report }: { report: DmDeclarationAccuracyReport | null }) {
  const m = useAdminMessages(adminAmuxDecisionMakerReportMessages) as Messages;
  return <AmuxDecisionMakerReportView m={m} report={report} />;
}
