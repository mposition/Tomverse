/**
 * Correction *candidates* for cost that was booked at a price the registry has
 * since corrected.
 *
 * Nothing here corrects anything. A settled reservation records the
 * `pricingVersion` and `costSource` it was priced under precisely so a later
 * price change is never retroactive, and re-running the arithmetic at today's
 * rate does not make the old figure wrong -- it makes it old. What it does
 * produce is the size of the gap between what an operational counter says was
 * spent and what the provider's own list price implies, which is the input to
 * an accounting reconciliation a human performs against a real invoice.
 *
 * Two things follow from that, and both are load-bearing:
 *
 *   * The output is grouped by (period, model, pricingVersion, costSource), so
 *     nobody can adjust "the model's cost" without seeing that several
 *     different priced decisions are underneath it.
 *   * A period that is still accruing is flagged, because that is the only one
 *     where an inflated figure is currently rejecting requests. A closed
 *     month's overstatement is a bookkeeping matter; the open one is an
 *     availability matter.
 *
 * Pure, so the arithmetic can be tested without a database.
 */

export type SettledReservationSample = {
  modelId: string;
  /** The bucket period this booked into, e.g. "op-cost-month". */
  period: string;
  /** UTC ISO timestamp of the start of that period's window. */
  periodStart: string;
  pricingVersion: string;
  costSource: string;
  /** What was actually added to the counter, in micro-USD. */
  bookedCostMicroUsd: number;
  settledInputTokens: number;
  settledCachedInputTokens: number;
  settledOutputTokens: number;
};

export type CurrentPrice = {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier: number;
  pricingVersion: string;
};

export type CorrectionCandidate = {
  period: string;
  periodStart: string;
  modelId: string;
  pricingVersion: string;
  costSource: string;
  reservationCount: number;
  bookedCostMicroUsd: number;
  expectedCostMicroUsd: number;
  /** booked - expected. Positive means the counter overstates the spend. */
  differenceMicroUsd: number;
  /** difference / expected, or null when expected is zero. */
  overstatementRatio: number | null;
  /** True when this period is the one currently gating requests. */
  isCurrentBlock: boolean;
};

/**
 * Recomputes one sample at today's price. Cached input is charged at the
 * multiplier, uncached at full rate, output at the output rate -- the same
 * shape lib/providerUsageCost.ts uses, restated rather than imported so this
 * module stays free of the runtime's dependencies.
 */
export const expectedCostMicroUsd = (
  sample: SettledReservationSample,
  price: CurrentPrice
): number => {
  const cached = Math.max(
    0,
    Math.min(sample.settledInputTokens, sample.settledCachedInputTokens)
  );
  const uncached = Math.max(0, sample.settledInputTokens - cached);
  return (
    uncached * price.inputUsdPerMillionTokens +
    cached * price.inputUsdPerMillionTokens * price.cachedInputPriceMultiplier +
    Math.max(0, sample.settledOutputTokens) * price.outputUsdPerMillionTokens
  );
};

export const buildCorrectionCandidates = ({
  samples,
  priceForModel,
  currentPeriodStarts,
  minimumDifferenceMicroUsd = 0,
}: {
  samples: readonly SettledReservationSample[];
  priceForModel: (modelId: string) => CurrentPrice | null;
  /** period -> the periodStart currently accruing, e.g. this month's start. */
  currentPeriodStarts: Readonly<Record<string, string>>;
  /** Suppresses rounding-sized noise. Defaults to reporting everything. */
  minimumDifferenceMicroUsd?: number;
}): CorrectionCandidate[] => {
  const groups = new Map<string, CorrectionCandidate>();

  for (const sample of samples) {
    const price = priceForModel(sample.modelId);
    // A model with no current price cannot be recomputed. Skipping it is the
    // honest outcome -- inventing one would produce a difference that is an
    // artefact of the guess.
    if (!price) continue;

    const key = [
      sample.period,
      sample.periodStart,
      sample.modelId,
      sample.pricingVersion,
      sample.costSource,
    ].join("|");

    const existing = groups.get(key) ?? {
      period: sample.period,
      periodStart: sample.periodStart,
      modelId: sample.modelId,
      pricingVersion: sample.pricingVersion,
      costSource: sample.costSource,
      reservationCount: 0,
      bookedCostMicroUsd: 0,
      expectedCostMicroUsd: 0,
      differenceMicroUsd: 0,
      overstatementRatio: null,
      isCurrentBlock:
        currentPeriodStarts[sample.period] === sample.periodStart,
    };

    existing.reservationCount += 1;
    existing.bookedCostMicroUsd += sample.bookedCostMicroUsd;
    existing.expectedCostMicroUsd += expectedCostMicroUsd(sample, price);
    groups.set(key, existing);
  }

  return [...groups.values()]
    .map((candidate) => {
      const difference =
        candidate.bookedCostMicroUsd - candidate.expectedCostMicroUsd;
      return {
        ...candidate,
        expectedCostMicroUsd: Math.round(candidate.expectedCostMicroUsd),
        differenceMicroUsd: Math.round(difference),
        overstatementRatio:
          candidate.expectedCostMicroUsd === 0
            ? null
            : difference / candidate.expectedCostMicroUsd,
      };
    })
    .filter(
      (candidate) =>
        Math.abs(candidate.differenceMicroUsd) >= minimumDifferenceMicroUsd
    )
    .sort(
      (a, b) =>
        Number(b.isCurrentBlock) - Number(a.isCurrentBlock) ||
        Math.abs(b.differenceMicroUsd) - Math.abs(a.differenceMicroUsd)
    );
};
