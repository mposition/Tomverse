import {
  INPUT_CREDIT_MULTIPLIERS,
  getWeightedUsageCredits,
  type AiModel,
} from "@/lib/models";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "@/lib/webSearchCredits";

export type CalculatorTier = "standard" | "advanced" | "premium";
export const CALCULATOR_TIERS: readonly CalculatorTier[] = ["standard", "advanced", "premium"];

const TIER_MODEL: Record<CalculatorTier, Pick<AiModel, "usageClass" | "creditWeight">> = {
  standard: { usageClass: "standard" },
  advanced: { usageClass: "advanced" },
  premium: { usageClass: "premium" },
};

/** One input-length band: the lowest token count inside it, and its multiplier. */
export const CALCULATOR_BANDS: ReadonlyArray<{ aboveTokens: number; sample: number; multiplier: number }> = [
  { aboveTokens: 0, sample: 0, multiplier: 1 },
  ...INPUT_CREDIT_MULTIPLIERS.map((band) => ({ aboveTokens: band.aboveTokens, sample: band.aboveTokens + 1, multiplier: band.multiplier })),
];

/**
 * What one send costs for the picked model tiers, input-length band and web search choice.
 * Every number comes from the code that charges them: the tier weights and the input
 * multipliers in lib/models.ts and the flat web search surcharge in lib/webSearchCredits.ts.
 * Each model is charged on its own and rounded up, exactly as a send is reserved, and the
 * search surcharge is per model and never multiplied by the input length.
 */
export function calculateSend(tiers: readonly CalculatorTier[], band: number, web: boolean) {
  const sample = CALCULATOR_BANDS[band]?.sample ?? 0;
  const models = tiers.reduce((sum, tier) => sum + getWeightedUsageCredits(TIER_MODEL[tier], sample), 0);
  const searchCredits = web ? WEB_SEARCH_SURCHARGE_CREDITS * tiers.length : 0;
  return { models, searchCredits, perSend: models + searchCredits };
}

/** How many sends a monthly allowance covers; zero when a send costs nothing to compute. */
export const requestsPerMonth = (monthlyCredits: number, perSend: number) =>
  perSend > 0 ? Math.floor(monthlyCredits / perSend) : 0;
