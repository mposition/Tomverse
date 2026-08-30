export type ProviderUsageCostInput = {
  /**
   * Every input token the provider counted, cached and uncached together.
   *
   * The AI SDK's `usage.inputTokens` is this total -- it is built as
   * `noCache + cacheRead + cacheWrite` (see `convertAnthropicUsage`), not the
   * API's own `input_tokens`, which is the uncached remainder only. The two
   * cache figures below are therefore *subtracted* from this rather than added
   * to it; treating them as extra would double-count a cached prompt.
   */
  inputTokens: number;
  /** Input tokens served from the prompt cache, at the cache-read rate. */
  cachedInputTokens?: number;
  /**
   * Input tokens *written* into the prompt cache, at the cache-write rate.
   *
   * A separate line from the read, because it is a separate line on the
   * provider's price list and moves the opposite way: a read is a discount
   * (0.1x) and a write is a premium (1.25x for the 5-minute TTL this
   * application uses). Folding writes into either of the other two figures is
   * what made a cache-enabled turn look 25% cheaper than it was --
   * see docs/policy/anthropic-prompt-caching.md section 4.
   */
  cacheWriteInputTokens?: number;
  outputTokens: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier?: number;
  /**
   * The provider's published cache-write rate, or null/undefined where this
   * application has no verified one.
   *
   * Absent is not zero. Writes that arrive with no rate to price them are
   * charged nothing and reported as `unpricedCacheWriteTokens`, so the gap is
   * a number somebody can see rather than a silent discount. Deriving the rate
   * from the input rate here would defeat the registry's own rule that every
   * price is read off the provider's list -- `lib/modelPricing.ts` holds the
   * verified figures and `npm run check:model-pricing` checks their multiple.
   */
  cacheWriteUsdPerMillionTokens?: number | null;
};

export type ProviderUsageCostBreakdown = {
  inputTokens: number;
  uncachedInputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
  cachedInputPriceMultiplier: number;
  /** Null where no verified rate priced the writes below. */
  cacheWriteUsdPerMillionTokens: number | null;
  uncachedInputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  cacheWriteInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  /**
   * Cache-write tokens this breakdown could not price, because the model has
   * no verified write rate. Zero on every path that has one.
   *
   * Reported rather than logged: a cost that is understated by a known token
   * count is a different thing from one that is complete, and a reader of a
   * stored snapshot has no other way to tell them apart.
   */
  unpricedCacheWriteTokens: number;
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
  cacheWriteInputTokens,
  outputTokens,
  inputUsdPerMillionTokens,
  outputUsdPerMillionTokens,
  cachedInputPriceMultiplier = 1,
  cacheWriteUsdPerMillionTokens,
}: ProviderUsageCostInput): ProviderUsageCostBreakdown => {
  const safeInput = safeTokens(inputTokens);
  const safeCached = Math.min(safeInput, safeTokens(cachedInputTokens));
  // Bounded by what is left after the reads, not by the input total: a
  // provider that reported reads and writes summing past its own input count
  // has contradicted itself, and the safe reading of that is fewer premium
  // tokens rather than more. Reads are taken first because they are the
  // cheaper line, so this can only ever move cost down -- never invent it.
  const safeCacheWrite = Math.min(
    safeInput - safeCached,
    safeTokens(cacheWriteInputTokens)
  );
  const safeOutput = safeTokens(outputTokens);
  const inputRate = safeRate(inputUsdPerMillionTokens);
  const outputRate = safeRate(outputUsdPerMillionTokens);
  const cachedMultiplier = Math.min(
    1,
    safeRate(cachedInputPriceMultiplier, 1)
  );
  // Null rather than 0 when unverified, and checked with a type guard rather
  // than `|| 0`: a write rate of zero and no write rate at all produce the
  // same cost and mean opposite things, and only one of them belongs in
  // `unpricedCacheWriteTokens`.
  const cacheWriteRate =
    typeof cacheWriteUsdPerMillionTokens === "number" &&
    Number.isFinite(cacheWriteUsdPerMillionTokens) &&
    cacheWriteUsdPerMillionTokens >= 0
      ? cacheWriteUsdPerMillionTokens
      : null;
  const uncachedInputTokens = safeInput - safeCached - safeCacheWrite;
  const uncachedInputCostMicroUsd = Math.ceil(
    uncachedInputTokens * inputRate
  );
  const cachedInputCostMicroUsd = Math.ceil(
    safeCached * inputRate * cachedMultiplier
  );
  const cacheWriteInputCostMicroUsd =
    cacheWriteRate === null
      ? 0
      : Math.ceil(safeCacheWrite * cacheWriteRate);
  const outputCostMicroUsd = Math.ceil(safeOutput * outputRate);

  return {
    inputTokens: safeInput,
    uncachedInputTokens,
    cachedInputTokens: safeCached,
    cacheWriteInputTokens: safeCacheWrite,
    outputTokens: safeOutput,
    inputUsdPerMillionTokens: inputRate,
    outputUsdPerMillionTokens: outputRate,
    cachedInputPriceMultiplier: cachedMultiplier,
    cacheWriteUsdPerMillionTokens: cacheWriteRate,
    uncachedInputCostMicroUsd,
    cachedInputCostMicroUsd,
    cacheWriteInputCostMicroUsd,
    outputCostMicroUsd,
    unpricedCacheWriteTokens: cacheWriteRate === null ? safeCacheWrite : 0,
    totalCostMicroUsd:
      uncachedInputCostMicroUsd +
      cachedInputCostMicroUsd +
      cacheWriteInputCostMicroUsd +
      outputCostMicroUsd,
  };
};
