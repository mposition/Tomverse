import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react";
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
}: {
  label: string;
  metric: ScorecardMetric;
  detail?: string;
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
          insufficient_evidence — {metric.denominator} of{" "}
          {metric.minimumDenominator} {metric.denominatorLabel}
        </p>
      ) : (
        <p className="mt-1 text-xs leading-5 text-zinc-500">
          {metric.numerator} of {metric.denominator} {metric.denominatorLabel}
        </p>
      )}
      {metric.excluded ? (
        <p className="mt-1 text-xs leading-5 text-zinc-600">
          excluded: {metric.excluded}
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

export function AdminAiReviewScorecardPanel({
  scorecards,
}: {
  scorecards: readonly AiReviewScorecard[];
}) {
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
                AI Review
              </span>
            </div>
            <h2 className="mt-3 text-2xl font-black text-white">
              M5 scorecard
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
              Reliability is written by the server on the path that calls the
              reviewer, so it needs no analytics consent and covers guest runs,
              failures, refusals and cache hits. Adoption is consented client
              telemetry and is never mixed into a reliability rate. A metric
              below its sample floor reports{" "}
              <span className="font-bold text-amber-300">
                insufficient_evidence
              </span>{" "}
              rather than a zero.
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
              ? `${quality.approvedPairCount} approved reviewer pair(s)`
              : "No approved reviewer pair"}
          </span>
        </div>
      </div>

      {scorecards.map((card) => (
        <div
          key={card.windowDays}
          className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6"
        >
          <h3 className="text-lg font-black text-white">
            Last {card.windowDays} days
          </h3>

          <p className="mt-4 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
            Reliability · server-recorded runs
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Count
              label="Runs recorded"
              value={String(card.reliability.runs)}
              detail={`${card.reliability.guestRuns} guest · ${card.reliability.accountRuns} account`}
            />
            <Rate label="Completion" metric={card.reliability.completionRate} />
            <Rate
              label="Primary only"
              metric={card.reliability.primaryOnlyRate}
              detail="Of completed runs, those with one reviewer"
            />
            <Rate
              label="Dual review available"
              metric={card.reliability.dualAvailabilityRate}
            />
            <Rate
              label="Dual review completed"
              metric={card.reliability.dualCompletionRate}
            />
            <Rate label="Cached" metric={card.reliability.cachedRate} />
            <Rate label="Retried" metric={card.reliability.retryRate} />
            <Rate
              label="Unreconciled settlements"
              metric={card.reliability.unreconciledSettlements}
              detail="Completed attempts with no settled figure at all"
            />
            <Rate
              label="Settled above reservation"
              metric={card.reliability.creditReconciliation}
              detail="Charged more than was held. Settling below a reservation is normal; above it is not."
            />
            <Count
              label="Duration p50 / p95"
              value={`${card.reliability.p50DurationMs ?? "—"} / ${card.reliability.p95DurationMs ?? "—"}`}
              detail="Milliseconds, completed runs only"
            />
            <Count
              label="Telemetry coverage"
              value={`${card.coverage.clientStartedEvents} / ${card.coverage.serverRuns}`}
              detail="Client events over server runs. A comparison, never a reliability rate: client events need consent."
            />
          </div>

          {card.reliability.reviewerHealth.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-left text-sm">
                <thead>
                  <tr className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
                    <th className="pb-2">Reviewer</th>
                    <th className="pb-2">Provider</th>
                    <th className="pb-2">Attempts</th>
                    <th className="pb-2">Failures</th>
                    <th className="pb-2">Failure rate</th>
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
                Attempts count only what reached a provider. A refusal for
                credits, a limit or the context window never sent anything and
                says nothing about the model.
              </p>
            </div>
          ) : (
            <p className="mt-3 text-xs leading-5 text-zinc-500">
              No reviewer attempt reached a provider in this window.
            </p>
          )}

          <p className="mt-6 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
            Adoption and value · consented client analytics
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Count
              label="Weekly active"
              value={String(card.adoption.weeklyActiveReviewUsers)}
              detail="Users who started or completed a review in the last 7 days"
            />
            <Rate
              label="Comparison → Review"
              metric={card.adoption.comparisonToReview}
            />
            <Rate
              label="Review → follow-up"
              metric={card.adoption.reviewToFollowUp}
            />
            <Rate
              label="Review → save or share"
              metric={card.adoption.reviewToSaveOrShare}
            />
            <Rate
              label="Review → item web check"
              metric={card.adoption.reviewToItemWebCheck}
            />
            <Rate
              label="First → second review"
              metric={card.adoption.firstToSecondReview}
              detail="Counted from completions: starting twice is not returning to a result"
            />
            <Rate
              label="D1 after first review"
              metric={card.adoption.reviewAnchoredReturnDay1}
            />
            <Rate
              label="D7 after first review"
              metric={card.adoption.reviewAnchoredReturnDay7}
            />
            <Rate
              label="D30 after first review"
              metric={card.adoption.reviewAnchoredReturnDay30}
            />
            <Rate
              label="D7 by account age"
              metric={card.adoption.accountAgeReturnDay7}
              detail="Comparable with the product-wide funnel, which uses the same events. Not review retention."
            />
            <Rate
              label="D7 · comparison-only cohort"
              metric={card.adoption.cohortReturnDay7.comparisonOnly}
            />
            <Rate
              label="D7 · AI Review cohort"
              metric={card.adoption.cohortReturnDay7.aiReview}
            />
          </div>
          <p className="mt-2 text-xs leading-5 text-zinc-600">
            The two cohorts self-selected. A difference between them is a
            difference in who used the feature as much as in what it did for
            them. Every conversion above is ordered -- the second event must
            follow the first -- which is the strongest claim these events
            support: they carry no conversation id, so a later action may
            belong to another thread. The review-anchored returns are a floor:
            a user who came back and generated no event is not counted.
          </p>
        </div>
      ))}

      <div className="rounded-3xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center gap-2 text-blue-300">
          <ShieldCheck className="h-5 w-5" />
          <span className="text-xs font-bold uppercase tracking-[0.18em]">
            Quality · reviewer-pair register
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Count
            label="Approved pairs"
            value={String(quality.approvedPairCount)}
            detail={`${quality.candidatePairCount} candidate(s)`}
          />
          <Count
            label="Dataset"
            value={quality.datasetVersion ?? "—"}
            detail={
              quality.datasetVersion
                ? `Evaluated ${quality.evaluatedAt ?? "—"}`
                : "No pair is approved, so no evaluation is cited"
            }
          />
          <Count
            label="Independent runs"
            value={
              quality.independentRunOrdinals.length > 0
                ? quality.independentRunOrdinals.join(", ")
                : "—"
            }
            detail="Distinct run ordinals the approval rests on"
          />
          <Count
            label="Critical violations"
            value={
              quality.zeroToleranceViolations === null
                ? "—"
                : String(quality.zeroToleranceViolations)
            }
            detail={
              quality.zeroToleranceViolations === null
                ? "Not measured — no approved pair"
                : "Zero-tolerance rule breaches recorded at approval"
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
            {quality.drift.inSync
              ? "The served reviewer pairs are exactly the approved ones."
              : "The served reviewer pairs do not match the approved ones."}
          </p>
          {!quality.drift.inSync ? (
            <ul className="mt-2 list-disc pl-5 text-xs leading-5">
              <li>
                Served but not approved:{" "}
                {quality.drift.servedButNotApproved.join(", ") || "none"}
              </li>
              <li>
                Approved but not served:{" "}
                {quality.drift.approvedButNotServed.join(", ") || "none"}
              </li>
            </ul>
          ) : null}
          <p className="mt-2 text-xs leading-5 opacity-80">
            Read from the running configuration, not from the register. Nothing
            on this screen changes the register, a feature flag or a release
            gate: approval is a person&apos;s act, recorded in commit history.
          </p>
        </div>
      </div>
    </section>
  );
}
