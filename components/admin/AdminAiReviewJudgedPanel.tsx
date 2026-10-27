"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpRight,
  Download,
  FileSearch,
  Search,
  ShieldCheck,
  X,
} from "lucide-react";
import { adminMessagesFor, type AdminLocale } from "@/lib/adminLocale";
import { adminAiReviewJudgedMessages } from "@/lib/adminMessages/aiReviewJudged";
import type {
  AiReviewCaseEvidence,
  AiReviewJudgedRunCatalog,
  AiReviewJudgedRunReport,
} from "@/lib/aiReviewJudgedReportTypes";
import type { AiReviewJudgedRunRate } from "@/lib/aiReviewJudgedRunAggregate";

type Messages = ReturnType<
  typeof adminMessagesFor<typeof adminAiReviewJudgedMessages.en>
>;
const panel = "rounded-2xl border border-zinc-800 bg-zinc-900";
const control =
  "min-h-10 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400";
const pct = (value: number | null) =>
  value === null ? "—" : `${(value * 100).toFixed(1)}%`;
const hasInvented = (item: AiReviewCaseEvidence) =>
  item.scoredClaimIndexes.some((index) => {
    const claim = item.record.claims[index];
    return (
      claim?.speechAct === "finding" &&
      claim.status === "confirmed" &&
      claim.outsideGoldVerdict === "false_finding"
    );
  });
const missedPlanted = (item: AiReviewCaseEvidence) =>
  item.outcome.scored &&
  Object.values(item.outcome.byKind).some((kind) => kind.falseNegatives > 0);

function Metric({
  title,
  help,
  metric,
  m,
}: {
  title: string;
  help: string;
  metric: AiReviewJudgedRunRate;
  m: Messages;
}) {
  return (
    <section className={`${panel} p-5 sm:p-6`} data-testid="judged-metric">
      <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
      <div className="mt-5 flex flex-wrap items-baseline gap-3">
        <strong className="text-4xl font-semibold tracking-tight text-zinc-100 tabular-nums">
          {pct(metric.rate)}
        </strong>
        <span className="text-sm text-zinc-400 tabular-nums">
          {metric.numerator} / {metric.denominator} {m.cases}
        </span>
      </div>
      <p className="mt-3 text-xs text-zinc-400">
        {metric.rate === null
          ? m.insufficient
          : `${m.interval} · ${pct(metric.wilsonLower)} – ${pct(metric.wilsonUpper)}`}
      </p>
      <p className="mt-5 border-t border-zinc-800 pt-4 text-sm leading-6 text-zinc-400">
        {help}
      </p>
    </section>
  );
}

function RateCell({
  metric,
  m,
}: {
  metric: AiReviewJudgedRunRate;
  m: Messages;
}) {
  return (
    <>
      <span className="font-medium tabular-nums text-zinc-100">
        {metric.rate === null ? m.insufficient : pct(metric.rate)}
      </span>
      <span className="ml-2 whitespace-nowrap text-xs tabular-nums text-zinc-400">
        {metric.numerator}/{metric.denominator}
      </span>
    </>
  );
}

function EvidenceDialog({
  item,
  onClose,
  m,
}: {
  item: AiReviewCaseEvidence | null;
  onClose: () => void;
  m: Messages;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (item && dialog && !dialog.open) dialog.showModal();
    if (!item && dialog?.open) dialog.close();
  }, [item]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="judged-evidence-title"
      className="m-auto max-h-[92dvh] w-[min(960px,calc(100%-24px))] max-w-none overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-0 text-zinc-100 shadow-2xl backdrop:bg-black/50"
    >
      {item && (
        <>
          <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-zinc-800 bg-zinc-900 p-5">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-blue-300">
                {m.evidence}
              </p>
              <h2
                id="judged-evidence-title"
                className="mt-1 break-all text-lg font-semibold"
              >
                {item.caseId}
              </h2>
              <p className="mt-1 text-xs text-zinc-400">
                {item.language} · {item.taskType} · {item.phenomenon}
              </p>
            </div>
            <button
              type="button"
              className={control}
              onClick={() => ref.current?.close()}
              aria-label={m.close}
            >
              <X size={18} />
            </button>
          </header>
          <div className="space-y-6 p-5 sm:p-6">
            <section>
              <h3 className="mb-2 text-xs font-semibold text-zinc-400">
                {m.question}
              </h3>
              <p className="whitespace-pre-wrap break-words text-sm leading-7">
                {item.question}
              </p>
            </section>
            <section>
              <h3 className="mb-3 font-semibold">{m.claims}</h3>
              <div className="space-y-3">
                {item.record.claims.length === 0 && (
                  <p className="text-sm text-zinc-400">{m.noClaims}</p>
                )}
                {item.record.claims.map((claim, index) => (
                  <article key={index} className={`${panel} p-4`}>
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded-md bg-blue-950 px-2 py-1 font-medium text-blue-200">
                        {m.target} {claim.targetLabel.toUpperCase()}
                      </span>
                      <span className="break-all text-zinc-400">
                        {claim.requirementId}
                      </span>
                      <span className="ml-auto text-zinc-400">
                        {item.scoredClaimIndexes.includes(index)
                          ? m.counted
                          : m.excluded}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-zinc-500">
                      {m.quote} · {claim.submittedAs}[{claim.sourceIndex ?? "—"}
                      ]
                    </p>
                    <blockquote className="mt-1 whitespace-pre-wrap break-words border-l-2 border-blue-400 pl-3 text-sm leading-7">
                      {claim.evidenceQuote}
                    </blockquote>
                    <p className="mt-3 text-sm text-zinc-300">
                      {m.requirement}:{" "}
                      {item.testCase.requirements.find(
                        (requirement) => requirement.id === claim.requirementId,
                      )?.description ?? claim.requirementId}
                    </p>
                    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-zinc-400">
                      {Object.entries({
                        assertion: claim.assertion,
                        speechAct: claim.speechAct,
                        role: claim.role ?? "finding",
                        sufficiency: claim.sufficiency ?? "sufficient",
                        ...(claim.outsideGoldVerdict
                          ? { outsideGoldVerdict: claim.outsideGoldVerdict }
                          : {}),
                      }).map(([key, value]) => (
                        <div key={key}>
                          <dt className="inline text-zinc-500">{key}: </dt>
                          <dd className="inline">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                ))}
              </div>
            </section>
            <section>
              <h3 className="mb-3 font-semibold">{m.original}</h3>
              <div className="grid gap-3 md:grid-cols-3">
                {item.responses.map((response) => (
                  <article key={response.label} className={`${panel} p-4`}>
                    <h4 className="mb-3 text-sm font-semibold text-blue-300">
                      {m.sources} {response.label.toUpperCase()}
                    </h4>
                    <p className="whitespace-pre-wrap break-words text-sm leading-7 text-zinc-300">
                      {response.content}
                    </p>
                  </article>
                ))}
              </div>
            </section>
            <p className="text-xs leading-6 text-zinc-400">
              {m.signature}: <strong>{item.record.reviewedBy}</strong> ·{" "}
              {item.record.reviewedAt}
            </p>
            <details className={`${panel} p-4`}>
              <summary className="cursor-pointer text-sm font-medium">
                {m.bindings} / {m.outcome}
              </summary>
              <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs leading-6 text-zinc-400">
                {JSON.stringify(
                  {
                    contractVersion: item.record.contractVersion,
                    sourceCaseDigest: item.record.sourceCaseDigest,
                    observationRef: item.record.observationRef,
                    goldCompleteness: item.testCase.goldCompleteness,
                    outcome: item.outcome,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        </>
      )}
    </dialog>
  );
}

function RunView({
  report,
  m,
}: {
  report: AiReviewJudgedRunReport;
  m: Messages;
}) {
  const [arm, setArm] = useState<"language" | "task">("language");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<AiReviewCaseEvidence | null>(null);
  const cases = useMemo(
    () =>
      report.cases.filter(
        (item) =>
          `${item.caseId} ${item.question}`
            .toLowerCase()
            .includes(query.toLowerCase()) &&
          (filter === "all" ||
            (filter === "invented" ? hasInvented(item) : missedPlanted(item))),
      ),
    [report.cases, query, filter],
  );
  if (!report.result.aggregable)
    return (
      <section className={`${panel} p-6`} data-testid="judged-run-refused">
        <h3 className="font-semibold text-amber-300">{m.refused}</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-400">{m.blockedHelp}</p>
        <ul className="mt-4 space-y-2 text-sm text-zinc-300">
          {report.result.blockers.map((reason, index) => (
            <li key={index} className="break-words rounded-lg bg-zinc-950 p-3">
              {reason}
            </li>
          ))}
        </ul>
      </section>
    );
  const { metrics } = report.result;
  const arms =
    arm === "language" ? report.result.byLanguage : report.result.byTaskType;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        <Metric
          title={m.missed}
          help={m.missedHelp}
          metric={metrics.missedEveryPlantedIssueRate}
          m={m}
        />
        <Metric
          title={m.invented}
          help={m.inventedHelp}
          metric={metrics.inventedFindingRate}
          m={m}
        />
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-3 px-1 text-xs text-zinc-400">
        <span>
          {m.aimed}:{" "}
          <strong className="text-zinc-100">
            {metrics.missedEveryPlantedIssueAimedAt}
          </strong>
        </span>
        <span>
          {m.findings}:{" "}
          <strong className="text-zinc-100">
            {metrics.inventedFindingCount}
          </strong>
        </span>
        <span>
          {m.negative}:{" "}
          <RateCell metric={metrics.inventedFindingRateNegativeSubset} m={m} />
        </span>
      </div>
      <section className={`${panel} overflow-hidden`}>
        <div className="flex flex-wrap items-center justify-between gap-3 p-5">
          <h3 className="font-semibold">{m.breakdown}</h3>
          <div className="flex gap-2" role="group" aria-label={m.breakdown}>
            {(["language", "task"] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={arm === value}
                onClick={() => setArm(value)}
                className={`${control} ${arm === value ? "border-blue-400 text-blue-300" : ""}`}
              >
                {value === "language" ? m.languages : m.tasks}
              </button>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              {arm === "language" ? m.languages : m.tasks}
            </caption>
            <thead className="border-y border-zinc-800 bg-zinc-950 text-xs text-zinc-400">
              <tr>
                {[m.arm, m.cases, m.missed, m.invented].map((title) => (
                  <th key={title} scope="col" className="px-5 py-3 font-medium">
                    {title}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {arms.map((item) => (
                <tr
                  key={item.arm}
                  className="border-b border-zinc-800 last:border-0"
                >
                  <th scope="row" className="px-5 py-4 font-medium">
                    {item.arm}
                  </th>
                  <td className="px-5 py-4 tabular-nums">{item.cases}</td>
                  <td className="px-5 py-4">
                    <RateCell
                      metric={item.metrics.missedEveryPlantedIssueRate}
                      m={m}
                    />
                  </td>
                  <td className="px-5 py-4">
                    <RateCell metric={item.metrics.inventedFindingRate} m={m} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="p-5 text-xs leading-5 text-zinc-400">{m.noThreshold}</p>
      </section>
      <section className={`${panel} p-5`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-semibold">
            {m.evidence}{" "}
            <span className="ml-2 text-sm font-normal text-zinc-500">
              {cases.length} / {report.cases.length}
            </span>
          </h3>
          <select
            className={control}
            aria-label={m.evidence}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          >
            <option value="all">{m.all}</option>
            <option value="invented">{m.inventedFilter}</option>
            <option value="missed">{m.missedFilter}</option>
          </select>
        </div>
        <label className="relative mt-4 block">
          <Search
            size={16}
            className="absolute left-3 top-3 text-zinc-500"
            aria-hidden="true"
          />
          <input
            aria-label={m.search}
            placeholder={m.search}
            className={`${control} w-full pl-9`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="mt-3 divide-y divide-zinc-800">
          {cases.map((item) => (
            <button
              type="button"
              key={item.caseId}
              onClick={() => setSelected(item)}
              className="flex w-full items-center gap-4 rounded-lg px-2 py-4 text-left transition-colors hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-blue-400"
              aria-label={`${m.inspect}: ${item.caseId}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="font-semibold text-blue-300">
                    {item.caseId}
                  </span>
                  <span className="text-zinc-500">
                    {item.language} · {item.taskType}
                  </span>
                  {hasInvented(item) && (
                    <span className="text-amber-300">{m.inventedFilter}</span>
                  )}
                  {missedPlanted(item) && (
                    <span className="text-amber-300">{m.missedFilter}</span>
                  )}
                </div>
                <p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-zinc-300">
                  {item.question}
                </p>
              </div>
              <ArrowUpRight size={18} className="shrink-0 text-zinc-500" />
            </button>
          ))}
          {cases.length === 0 && (
            <p className="py-8 text-center text-sm text-zinc-400" role="status">
              {m.noResults}
            </p>
          )}
        </div>
      </section>
      <EvidenceDialog item={selected} onClose={() => setSelected(null)} m={m} />
    </>
  );
}

export function AdminAiReviewJudgedPanel({
  catalog,
  locale,
}: {
  catalog: AiReviewJudgedRunCatalog;
  locale: AdminLocale;
}) {
  const m = adminMessagesFor(adminAiReviewJudgedMessages, locale);
  const [runId, setRunId] = useState(catalog.reports[0]?.id ?? "");
  const report =
    catalog.reports.find((item) => item.id === runId) ?? catalog.reports[0];
  const download = () => {
    if (!report) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-review-${report.id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section
      className="min-w-0 space-y-5 text-zinc-100"
      data-testid="admin-ai-review-judged"
    >
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-blue-300">
            AI Review / M5
          </p>
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {m.title}
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-400">
            {m.subtitle}
          </p>
        </div>
        {report && (
          <button
            type="button"
            className={`${control} flex items-center gap-2`}
            onClick={download}
            title={m.exportNotice}
          >
            <Download size={16} />
            {m.export}
          </button>
        )}
      </header>
      {catalog.problems.length > 0 && (
        <details className={`${panel} p-4`}>
          <summary className="cursor-pointer text-sm text-amber-300">
            {m.reportProblems} ({catalog.problems.length})
          </summary>
          <ul className="mt-3 space-y-2 break-words text-xs text-zinc-400">
            {catalog.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </details>
      )}
      {!report ? (
        <section
          className={`${panel} px-6 py-12 text-center`}
          data-testid="judged-run-empty"
        >
          <FileSearch className="mx-auto text-zinc-500" size={32} />
          <h3 className="mt-5 text-lg font-semibold">
            {catalog.state === "unavailable" ? m.unavailable : m.emptyTitle}
          </h3>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-7 text-zinc-400">
            {m.emptyHelp}
          </p>
          <details className="mx-auto mt-6 max-w-2xl text-left">
            <summary className="cursor-pointer text-center text-sm font-medium text-blue-300">
              {m.configuration}
            </summary>
            <p className="mt-4 break-words rounded-xl bg-zinc-950 p-4 text-sm leading-7 text-zinc-400">
              {m.configHelp}
            </p>
          </details>
        </section>
      ) : (
        <>
          <div className={`${panel} flex flex-wrap items-center gap-4 p-4`}>
            <label className="min-w-0 flex-1 text-xs text-zinc-400">
              {m.run}
              <select
                value={report.id}
                onChange={(event) => setRunId(event.target.value)}
                className={`${control} mt-1 block w-full`}
                aria-label={m.run}
              >
                {catalog.reports.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.id}
                  </option>
                ))}
              </select>
            </label>
            <div className="text-xs leading-6 text-zinc-400">
              <p>
                {m.version}: {report.datasetVersion ?? "—"}
              </p>
              <p>
                {m.totals}: {report.completedCases ?? "—"} /{" "}
                {report.plannedCases ?? "—"}
              </p>
            </div>
            <span
              className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs ${report.result.aggregable ? "bg-blue-950 text-blue-200" : "bg-amber-950 text-amber-200"}`}
            >
              <ShieldCheck size={14} />
              {report.result.aggregable ? m.verified : m.refused}
            </span>
          </div>
          <RunView key={report.id} report={report} m={m} />
        </>
      )}
      <aside className="rounded-xl border border-zinc-800 bg-zinc-950 px-5 py-4">
        <h3 className="text-sm font-semibold text-zinc-300">{m.noApproval}</h3>
        <p className="mt-1 text-xs leading-6 text-zinc-400">{m.approvalHelp}</p>
      </aside>
    </section>
  );
}
