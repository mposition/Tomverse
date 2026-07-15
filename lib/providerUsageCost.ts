export type ProviderUsageCostInput = {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier?: number;
};

export type ProviderUsageCostBreakdown = {
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier: number;
  uncachedInputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  totalCostMicroUsd: number;
};

const safeTokens = (value: number | undefined) =>
  Number.isSafeInteger(value) ? Math.max(0, value!) : 0;

const safeRate = (value: number, fallback = 0) =>
  Number.isFinite(value) && value >= 0 ? value : fallback;

/**
 * A USD-per-million-token rate is numerically equal to micro-USD per token.
 * Each component is rounded up independently so a stored snapshot never
 * understates provider cost by dropping fractional micro-USD components.
 */
export const calculateProviderUsageCost = ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  inputUsdPerMillionTokens,
  outputUsdPerMillionTokens,
  cachedInputPriceMultiplier = 1,
}: ProviderUsageCostInput): ProviderUsageCostBreakdown => {
  const safeInput = safeTokens(inputTokens);
  const safeCached = Math.min(safeInput, safeTokens(cachedInputTokens));
  const safeOutput = safeTokens(outputTokens);
  const inputRate = safeRate(inputUsdPerMillionTokens);
  const outputRate = safeRate(outputUsdPerMillionTokens);
  const cachedMultiplier = Math.min(
    1,
    safeRate(cachedInputPriceMultiplier, 1)
  );
  const uncachedInputTokens = safeInput - safeCached;
  const uncachedInputCostMicroUsd = Math.ceil(
    uncachedInputTokens * inputRate
  );
  const cachedInputCostMicroUsd = Math.ceil(
    safeCached * inputRate * cachedMultiplier
  );
  const outputCostMicroUsd = Math.ceil(safeOutput * outputRate);

  return {
    inputTokens: safeInput,
    uncachedInputTokens,
    cachedInputTokens: safeCached,
    outputTokens: safeOutput,
    inputUsdPerMillionTokens: inputRate,
    outputUsdPerMillionTokens: outputRate,
    cachedInputPriceMultiplier: cachedMultiplier,
    uncachedInputCostMicroUsd,
    cachedInputCostMicroUsd,
    outputCostMicroUsd,
    totalCostMicroUsd:
      uncachedInputCostMicroUsd +
      cachedInputCostMicroUsd +
      outputCostMicroUsd,
  };
};
