export type ProviderFailureHealthInput = {
  successCount: number;
  failureCount: number;
  consecutiveSuccesses: number;
  minimumSamples?: number;
  minimumFailures?: number;
  limitedFailureRatePercent?: number;
  outageFailureRatePercent?: number;
  outageMinimumFailures?: number;
  recoverySuccesses?: number;
};

export type ProviderFailureHealth = {
  totalCount: number;
  failureRatePercent: number | null;
  enoughSamples: boolean;
  recovered: boolean;
  limited: boolean;
  outage: boolean;
};

const nonNegativeInteger = (value: number) =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

const boundedPercent = (value: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;

export const evaluateProviderFailureHealth = ({
  successCount,
  failureCount,
  consecutiveSuccesses,
  minimumSamples = 5,
  minimumFailures = 3,
  limitedFailureRatePercent = 50,
  outageFailureRatePercent = 80,
  outageMinimumFailures = 5,
  recoverySuccesses = 3,
}: ProviderFailureHealthInput): ProviderFailureHealth => {
  const successes = nonNegativeInteger(successCount);
  const failures = nonNegativeInteger(failureCount);
  const successStreak = nonNegativeInteger(consecutiveSuccesses);
  const totalCount = successes + failures;
  const failureRatePercent =
    totalCount > 0 ? Math.round((failures / totalCount) * 1_000) / 10 : null;
  const enoughSamples = totalCount >= nonNegativeInteger(minimumSamples);
  const recovered =
    successStreak >= Math.max(1, nonNegativeInteger(recoverySuccesses));
  const limitedThresholdReached =
    enoughSamples &&
    failures >= nonNegativeInteger(minimumFailures) &&
    (failureRatePercent || 0) >=
      boundedPercent(limitedFailureRatePercent, 50);
  const outageThresholdReached =
    limitedThresholdReached &&
    failures >= nonNegativeInteger(outageMinimumFailures) &&
    (failureRatePercent || 0) >=
      boundedPercent(outageFailureRatePercent, 80);

  return {
    totalCount,
    failureRatePercent,
    enoughSamples,
    recovered,
    limited: limitedThresholdReached && !recovered && !outageThresholdReached,
    outage: outageThresholdReached && !recovered,
  };
};

export const isEmptyResponseDiagnostic = (code: string | null | undefined) =>
  Boolean(code && code.startsWith("AI_EMPTY_RESPONSE."));
