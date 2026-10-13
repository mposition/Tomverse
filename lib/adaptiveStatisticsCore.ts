/** Content-free aggregates for actual Chat Refiner and Auto Router executions. */
import { CANDIDATE_REJECTIONS } from "@/lib/routerCandidates";

const rejectionCodes = new Set<string>(CANDIDATE_REJECTIONS);
export type RefinerStatRow = {
  outcome: string;
  failureCode: string | null;
  preparationLatencyMs: number;
  actualCostMicroUsd: bigint | null;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  productContext: { mode: string } | null;
  dispositions: Array<{ outcome: string }>;
};

export type RouterStatRow = {
  reservationId: string | null;
  estimatedInputTokens: number;
  plan: string;
  profileKind: string;
  selectionPolicyVersion: string | null;
  selectionReason: string;
  eligibleCount: number;
  rejectedByReason: unknown;
  initialModelId: string | null;
  finalModelId: string | null;
  rerouteCount: number;
  fallbackState: string;
  settlementOutcome: string | null;
  decisionMicros: number;
  totalLatencyMs: number | null;
  firstTokenMs: number | null;
  routingAttempts: Array<{ outcome: string; failureLayer: string }>;
};

export type AutoUsageStatRow = {
  reservationId: string;
  costMicroUsd: bigint;
  costSource: string;
  inputTokens: number | null;
  outputTokens: number | null;
  adjustments: Array<{ costDeltaMicroUsd: bigint }>;
};

const counts = (values: Array<string | null | undefined>) => {
  const result: Record<string, number> = Object.create(null);
  for (const value of values) {
    const key = value ?? "unrecorded";
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
};

const nearestRank = (values: number[], percentile: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * percentile) - 1];
};

const measure = (values: Array<number | bigint | null>) => {
  const known = values.filter((value): value is number | bigint => value !== null);
  return {
    population: values.length,
    reported: known.length,
    missing: values.length - known.length,
    total: known.reduce<bigint>((sum, value) => sum + BigInt(value), BigInt(0)).toString(),
  };
};

export function buildAdaptiveStatistics(refiner: RefinerStatRow[], router: RouterStatRow[], usage: AutoUsageStatRow[] = []) {
  const suggested = refiner.filter((row) => row.outcome === "suggested");
  const dispatched = refiner.filter((row) => row.outcome !== "refused_before_dispatch");
  const explicitChoices = suggested.flatMap((row) =>
    row.productContext?.mode === "explicit"
      ? row.dispositions.map((item) => item.outcome).filter((outcome) => outcome === "accepted" || outcome === "kept_original")
      : []
  );
  const rejectedReasons: Record<string, number> = {};
  for (const row of router) {
    if (!row.rejectedByReason || typeof row.rejectedByReason !== "object" || Array.isArray(row.rejectedByReason)) continue;
    for (const [reason, value] of Object.entries(row.rejectedByReason)) {
      if (rejectionCodes.has(reason) && typeof value === "number" && Number.isFinite(value) && value >= 0) {
        rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + value;
      }
    }
  }
  const reservationIds = new Set(router.flatMap((row) => row.reservationId === null ? [] : [row.reservationId]));
  const usageForRuns = usage.filter((row) => reservationIds.has(row.reservationId));
  const reservationsWithUsage = new Set(usageForRuns.map((row) => row.reservationId));
  const costSources = usageForRuns.map((row) => row.adjustments.length > 0 ? "late_provider_actual" : row.costSource);
  const resolvedCosts = usageForRuns.map((row) =>
    row.costMicroUsd + row.adjustments.reduce((sum, adjustment) => sum + adjustment.costDeltaMicroUsd, BigInt(0))
  );
  const measuredCosts = resolvedCosts.filter((_, index) => costSources[index] !== "reserved_upper_bound");
  return {
    refiner: {
      requests: refiner.length,
      byMode: counts(refiner.map((row) => row.productContext?.mode)),
      outcomes: counts(refiner.map((row) => row.outcome)),
      failureCodes: counts(refiner.filter((row) => row.failureCode).map((row) => row.failureCode)),
      explicitDispositions: counts(refiner.filter((row) => row.productContext?.mode === "explicit").flatMap((row) => row.dispositions.map((item) => item.outcome))),
      autoDispositions: counts(refiner.filter((row) => row.productContext?.mode === "auto").flatMap((row) => row.dispositions.map((item) => item.outcome))),
      explicitChoice: { accepted: explicitChoices.filter((item) => item === "accepted").length, denominator: explicitChoices.length },
      dispatched: dispatched.length,
      dispatchedFailures: dispatched.filter((row) => row.outcome === "failed").length,
      suggestionLatencyMs: { population: suggested.length, p50: nearestRank(suggested.map((row) => row.preparationLatencyMs), 0.5), p95: nearestRank(suggested.map((row) => row.preparationLatencyMs), 0.95) },
      actualCostMicroUsd: measure(refiner.map((row) => row.actualCostMicroUsd)),
      inputTokens: measure(refiner.map((row) => row.inputTokens)),
      outputTokens: measure(refiner.map((row) => row.outputTokens)),
    },
    autoRouter: {
      recordedRuns: router.length,
      byPlan: counts(router.map((row) => row.plan)),
      estimatedInputTokens: measure(router.map((row) => row.estimatedInputTokens)),
      byProfile: counts(router.map((row) => row.profileKind)),
      policyVersions: counts(router.map((row) => row.selectionPolicyVersion)),
      selectionReasons: counts(router.map((row) => row.selectionReason)),
      rejectedReasons,
      eligibleCandidates: measure(router.map((row) => row.eligibleCount)),
      initialModels: counts(router.map((row) => row.initialModelId)),
      finalModels: counts(router.map((row) => row.finalModelId)),
      rerouted: router.filter((row) => row.rerouteCount > 0).length,
      fallbackStates: counts(router.map((row) => row.fallbackState)),
      settlementOutcomes: counts(router.map((row) => row.settlementOutcome)),
      attemptOutcomes: counts(router.flatMap((row) => row.routingAttempts.map((attempt) => attempt.outcome))),
      attemptFailureLayers: counts(router.flatMap((row) => row.routingAttempts.filter((attempt) => attempt.failureLayer !== "none").map((attempt) => attempt.failureLayer))),
      decisionMs: { population: router.length, p50: nearestRank(router.map((row) => row.decisionMicros / 1000), 0.5), p95: nearestRank(router.map((row) => row.decisionMicros / 1000), 0.95) },
      totalLatencyMs: { population: router.filter((row) => row.totalLatencyMs !== null).length, missing: router.filter((row) => row.totalLatencyMs === null).length, p50: nearestRank(router.flatMap((row) => row.totalLatencyMs === null ? [] : [row.totalLatencyMs]), 0.5), p95: nearestRank(router.flatMap((row) => row.totalLatencyMs === null ? [] : [row.totalLatencyMs]), 0.95) },
      firstTokenMs: { population: router.filter((row) => row.firstTokenMs !== null).length, missing: router.filter((row) => row.firstTokenMs === null).length, p50: nearestRank(router.flatMap((row) => row.firstTokenMs === null ? [] : [row.firstTokenMs]), 0.5), p95: nearestRank(router.flatMap((row) => row.firstTokenMs === null ? [] : [row.firstTokenMs]), 0.95) },
      providerUsage: {
        attemptRows: usageForRuns.length,
        runsWithoutUsage: router.filter((row) => !row.reservationId || !reservationsWithUsage.has(row.reservationId)).length,
        costSources: counts(costSources),
        measuredOrTokenEstimatedCostMicroUsd: measure(measuredCosts),
        upperBoundCostRows: costSources.filter((source) => source === "reserved_upper_bound").length,
        inputTokens: measure(usageForRuns.map((row) => row.inputTokens)),
        outputTokens: measure(usageForRuns.map((row) => row.outputTokens)),
      },
    },
  };
}
