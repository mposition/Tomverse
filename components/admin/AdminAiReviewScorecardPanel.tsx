import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react";
import type { AdminMessageShape } from "@/lib/adminLocale";
import { getAdminMessages } from "@/lib/adminLocaleServer";
import { adminAiReviewScorecardMessages } from "@/lib/adminMessages/aiReviewScorecard";
import type { AiReviewScorecard } from "@/lib/aiReviewScorecard";
import type { ScorecardMetric } from "@/lib/aiReviewScorecardCore";

/**
 * The AI Review M5 scorecard.
 *
 * docs/policy/ai-review-m5-quality-contract.md §8, and the definitions in
 * docs/ops/ai-review-metric-dictionary.md.
 *
 * Every number here comes from `lib/aiReviewScorecardCore.ts`, the same
 * functions `npm run report:ai-review-operations` calls. A second aggregation
 * written against the same tables is how two surfaces come to disagree about
 * what a rate means, so this component does no arithmetic of its own beyond
 * formatting.
 *
 * The three sections are deliberately separate and separately labelled:
 * reliability is server-recorded and needs no consent, adoption is consented
 * client telemetry, and quality comes from the reviewer-pair register. Folding
 * them into one score would make a consent decision look like an outage.
 */

type RateMessages = AdminMessageShape<
  (typeof adminAiReviewScorecardMessages)["en"]["rate"]
>;

const pct = (metric: ScorecardMetric) =>
  metric.status === "ok" && metric.value !== null
    ? `${(metric.value * 100).toFixed(1)}%`
    : "—";

/**
 * A rate with its own denominator beside it.
 *
 * The denominator is not optional detail: a rate without one is a number
 * nobody can argue with, and an `insufficient_evidence` state that rendered as
 * "0%" would read as a measured failure.
 */
function Rate({
  label,
  metric,
  detail,
  m,
}: {
  label: string;
  metric: ScorecardMetric;
  detail?: string;
  m: RateMessages;
}) {
  const insufficient = metric.status !== "ok";
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </p>
      <p
        className={`mt-3 text-2xl font-black ${insufficient ? "text-zinc-500" : "text-white"}`}
      >
        {pct(metric)}
      </p>
      {insufficient ? (
        <p className="mt-1 text-xs leading-5 text-amber-300">
          {m.insufficient(
            metric.denominator,
            metric.minimumDenominator,
            metric.denominatorLabel
          )}
        </p>
      ) : (
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          {m.ratio(metric.numerator, metric.denominator, metric.denominatorLabel)}
        </p>
      )}
      {metric.excluded ? (
        <p className="mt-1 text-xs leading-5 text-zinc-600">
          {m.excluded(metric.excluded)}
        </p>
      ) : null}
      {detail ? (
        <p className="mt-1 text-xs leading-5 text-zinc-600">{detail}</p>
      ) : null}
    </div>
  );
}

function Count({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/70 p-4">
      <p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
        {label}
      </p>
      <p className="mt-3 text-2xl font-black text-white">{value}</p>
      <p className="mt-1 text-xs leading-5 text-zinc-500">{detail}</p>
    </div>
  );
}

export async function AdminAiReviewScorecardPanel({
  scorecards,
}: {
  scorecards: readonly AiReviewScorecard[];
}) {
  const m = await getAdminMessages(adminAiReviewScorecardMessages);
  const primary = scorecards[0];
  if (!primary) return null;
  const { quality } = primary;

  return (
    <section className="flex flex-col gap-4" data-testid="admin-ai-review-scorecard">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-blue-300">
              <BarChart3 className="h-5 w-5" />
              <span className="text-xs font-bold uppercase tracking-[0.18em]">
                {m.eyebrow}
              </span>
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">
              {m.title}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              {m.descriptionBefore}{" "}
              <span className="font-bold text-amber-300">
                insufficient_evidence
              </span>{" "}
              {m.descriptionAfter}
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${
              quality.approvedPairCount > 0
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                : "border-amber-500/30 bg-amber-500/10 text-amber-300"
            }`}
          >
            {quality.approvedPairCount > 0 ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <AlertTriangle className="h-4 w-4" />
            )}
            {quality.approvedPairCount > 0
              ? m.approvedPairs(quality.approvedPairCount)
              : m.noApprovedPair}
          </span>
        </div>
      </div>

      {scorecards.map((card) => (
        <div
          key={card.windowDays}
          className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          <h3 className="text-lg font-black text-white">
            {m.lastDays(card.windowDays)}
          </h3>

          <p className="mt-4 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
            {m.reliabilityHeading}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Count
              label={m.runsRecorded}
              value={String(card.reliability.runs)}
              detail={m.runsRecordedDetail(
                card.reliability.guestRuns,
                card.reliability.accountRuns
              )}
            />
            <Rate m={m.rate} label={m.completion} metric={card.reliability.completionRate} />
            <Rate
              m={m.rate}
              label={m.primaryOnly}
              metric={card.reliability.primaryOnlyRate}
              detail={m.primaryOnlyDetail}
            />
            <Rate
              m={m.rate}
              label={m.dualAvailable}
              metric={card.reliability.dualAvailabilityRate}
            />
            <Rate
              m={m.rate}
              label={m.dualCompleted}
              metric={card.reliability.dualCompletionRate}
            />
            <Rate m={m.rate} label={m.cached} metric={card.reliability.cachedRate} />
            <Rate m={m.rate} label={m.retried} metric={card.reliability.retryRate} />
            <Rate
              m={m.rate}
              label={m.unreconciled}
              metric={card.reliability.unreconciledSettlements}
              detail={m.unreconciledDetail}
            />
            <Rate
              m={m.rate}
              label={m.settledAbove}
              metric={card.reliability.creditReconciliation}
              detail={m.settledAboveDetail}
            />
            <Count
              label={m.duration}
              value={`${card.reliability.p50DurationMs ?? "—"} / ${card.reliability.p95DurationMs ?? "—"}`}
              detail={m.durationDetail}
            />
            <Count
              label={m.telemetryCoverage}
              value={`${card.coverage.clientStartedEvents} / ${card.coverage.serverRuns}`}
              detail={m.telemetryCoverageDetail}
            />
          </div>

          {card.reliability.reviewerHealth.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                    <th className="pb-2">{m.reviewer}</th>
                    <th className="pb-2">{m.provider}</th>
                    <th className="pb-2">{m.attempts}</th>
                    <th className="pb-2">{m.failures}</th>
                    <th className="pb-2">{m.failureRate}</th>
                  </tr>
                </thead>
                <tbody className="text-zinc-300">
                  {card.reliability.reviewerHealth.map((reviewer) => (
                    <tr
                      key={reviewer.reviewerModelId}
                      className="border-t border-zinc-800"
                    >
                      <td className="py-2 font-mono text-xs">
                        {reviewer.reviewerModelId}
                      </td>
                      <td className="py-2">{reviewer.provider ?? "—"}</td>
                      <td className="py-2">{reviewer.attempts}</td>
                      <td className="py-2">{reviewer.failures}</td>
                      <td className="py-2">{pct(reviewer.failureRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs leading-5 text-zinc-600">
                {m.attemptsNote}
              </p>
            </div>
          ) : (
            <p className="mt-3 text-xs leading-5 text-zinc-500">
              {m.noAttempts}
            </p>
          )}

          <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
            {m.adoptionHeading}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Count
              label={m.weeklyActive}
              value={String(card.adoption.weeklyActiveReviewUsers)}
              detail={m.weeklyActiveDetail}
            />
            <Rate
              m={m.rate}
              label={m.comparisonToReview}
              metric={card.adoption.comparisonToReview}
            />
            <Rate
              m={m.rate}
              label={m.reviewToFollowUp}
              metric={card.adoption.reviewToFollowUp}
            />
            <Rate
              m={m.rate}
              label={m.reviewToSaveOrShare}
              metric={card.adoption.reviewToSaveOrShare}
            />
            <Rate
              m={m.rate}
              label={m.reviewToItemWebCheck}
              metric={card.adoption.reviewToItemWebCheck}
            />
            <Rate
              m={m.rate}
              label={m.firstToSecondReview}
              metric={card.adoption.firstToSecondReview}
              detail={m.firstToSecondReviewDetail}
            />
            <Rate
              m={m.rate}
              label={m.d1AfterFirstReview}
              metric={card.adoption.reviewAnchoredReturnDay1}
            />
            <Rate
              m={m.rate}
              label={m.d7AfterFirstReview}
              metric={card.adoption.reviewAnchoredReturnDay7}
            />
            <Rate
              m={m.rate}
              label={m.d30AfterFirstReview}
              metric={card.adoption.reviewAnchoredReturnDay30}
            />
            <Rate
              m={m.rate}
              label={m.d7ByAccountAge}
              metric={card.adoption.accountAgeReturnDay7}
              detail={m.d7ByAccountAgeDetail}
            />
            <Rate
              m={m.rate}
              label={m.d7ComparisonOnly}
              metric={card.adoption.cohortReturnDay7.comparisonOnly}
            />
            <Rate
              m={m.rate}
              label={m.d7AiReview}
              metric={card.adoption.cohortReturnDay7.aiReview}
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-zinc-600">
            {m.cohortNote}
          </p>
        </div>
      ))}

      <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center gap-2 text-blue-300">
          <ShieldCheck className="h-5 w-5" />
          <span className="text-xs font-bold uppercase tracking-[0.18em]">
            {m.qualityHeading}
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Count
            label={m.approvedPairsLabel}
            value={String(quality.approvedPairCount)}
            detail={m.candidates(quality.candidatePairCount)}
          />
          <Count
            label={m.dataset}
            value={quality.datasetVersion ?? "—"}
            detail={
              quality.datasetVersion
                ? m.evaluated(quality.evaluatedAt ?? "—")
                : m.noEvaluationCited
            }
          />
          <Count
            label={m.independentRuns}
            value={
              quality.independentRunOrdinals.length > 0
                ? quality.independentRunOrdinals.join(", ")
                : "—"
            }
            detail={m.independentRunsDetail}
          />
          <Count
            label={m.criticalViolations}
            value={
              quality.zeroToleranceViolations === null
                ? "—"
                : String(quality.zeroToleranceViolations)
            }
            detail={
              quality.zeroToleranceViolations === null
                ? m.violationsNotMeasured
                : m.violationsDetail
            }
          />
        </div>
        <div
          className={`mt-4 rounded-2xl border p-4 text-sm leading-6 ${
            quality.drift.inSync
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
              : "border-amber-500/30 bg-amber-500/10 text-amber-200"
          }`}
        >
          <p className="font-bold">
            {quality.drift.inSync ? m.driftInSync : m.driftOutOfSync}
          </p>
          {!quality.drift.inSync ? (
            <ul className="mt-2 list-disc pl-5 text-xs leading-5">
              <li>
                {m.servedNotApproved}{" "}
                {quality.drift.servedButNotApproved.join(", ") || m.none}
              </li>
              <li>
                {m.approvedNotServed}{" "}
                {quality.drift.approvedButNotServed.join(", ") || m.none}
              </li>
            </ul>
          ) : null}
          <p className="mt-2 text-xs leading-5 opacity-80">
            {m.registerNote}
          </p>
        </div>
      </div>
    </section>
  );
}
