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
      className="flex min-w-0 flex-col gap-4 rounded-xl border border-zinc-800 bg-zinc-900 p-5"
      data-testid="amux-decision-maker-report-panel"
    >
      <header className="flex flex-col gap-1.5">
        <h2 className="text-base font-bold text-zinc-100">{m.title}</h2>
        <p className="text-sm leading-6 text-zinc-400">{m.description}</p>
        <p className="text-xs leading-5 text-zinc-500">{m.noEffect}</p>
      </header>
      {report === null ? (
        <p role="alert" className="text-sm text-red-300" data-testid="amux-dm-report-unavailable">
          {m.unavailable}
        </p>
      ) : (
        <>
          {report.instances.map((entry) => (
            <div key={entry.instance} className="flex flex-col gap-2">
              <h3 className="font-mono text-sm font-semibold text-zinc-100" data-testid={`amux-dm-report-instance-${entry.instance}`}>
                {entry.instance}
              </h3>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {ROWS.map((row) => {
                  const measured = row === "daysSinceFirstProposal"
                    ? entry.daysSinceFirstProposal.status !== "insufficient_evidence"
                    : entry[row].status !== "insufficient_evidence";
                  return (
                    <div key={row} className="flex min-w-0 flex-col gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3" data-testid={`amux-dm-report-${row}`}>
                      <dt className="text-xs leading-5 text-zinc-400">{m[row]}</dt>
                      <dd
                        className={measured ? "break-words text-lg font-bold text-zinc-100" : "break-words text-sm font-semibold text-zinc-500"}
                        data-testid={`amux-dm-report-${row}-${entry.instance}`}
                      >
                        {cellText(m, entry, row)}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          ))}
          <p className="text-xs text-zinc-500" data-testid="amux-dm-report-computed-at">
            {m.computedAt(dmReportInstant(report.dbNowMs))}
          </p>
        </>
      )}
    </section>
  );
}

export function AmuxDecisionMakerReportPanel({ report }: { report: DmDeclarationAccuracyReport | null }) {
  const m = useAdminMessages(adminAmuxDecisionMakerReportMessages) as Messages;
  return <AmuxDecisionMakerReportView m={m} report={report} />;
}
