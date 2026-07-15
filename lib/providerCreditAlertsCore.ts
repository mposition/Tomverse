export type ProviderCreditAlertLevel = "50" | "20" | "5" | "none";

export const providerCreditRemainingPercent = ({
  configuredCreditMicroUsd,
  estimatedBalanceMicroUsd,
}: {
  configuredCreditMicroUsd: number | null;
  estimatedBalanceMicroUsd: number | null;
}) => {
  if (
    configuredCreditMicroUsd === null ||
    configuredCreditMicroUsd <= 0 ||
    estimatedBalanceMicroUsd === null
  ) {
    return null;
  }
  return (
    Math.round(
      (estimatedBalanceMicroUsd / configuredCreditMicroUsd) * 100 * 10
    ) / 10
  );
};

export const providerCreditAlertLevel = (
  remainingPercent: number | null
): ProviderCreditAlertLevel => {
  if (remainingPercent === null) return "none";
  if (remainingPercent <= 5) return "5";
  if (remainingPercent <= 20) return "20";
  if (remainingPercent <= 50) return "50";
  return "none";
};
