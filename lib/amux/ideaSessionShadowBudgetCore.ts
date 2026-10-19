import { isAmuxIdeaAnalysisProvider, type AmuxIdeaAnalysisProvider } from
  "./ideaAnalysisChannelCore.ts";

/** v19 subscription CLI admission only: any of the four channels, each on its
 * subscription account (owner decision 2026-10-20). The returned hold occupies
 * the remaining monthly headroom; it is not a per-invocation cost ceiling. */
export type SessionShadowBudgetBasis = {
  mode: "subscription_cli";
  provider: AmuxIdeaAnalysisProvider;
  asOfIso: string;
  pricingVerifiedAt: string;
  pricingExpiresAt: string;
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  worstTierVerified: boolean;
  billableToolsDisabled: boolean;
  consumedMicroUsd: string;
  reservedMicroUsd: string;
  shadowOverrunMicroUsd: string;
  monthlyLimitMicroUsd: string;
  usageState: "known" | "unknown";
};

const AMOUNT = /^(0|[1-9][0-9]*)$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const validAmount = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 19 && AMOUNT.test(value) &&
  BigInt(value) <= BigInt("9223372036854775807");
const validInstant = (value: unknown): value is string =>
  typeof value === "string" && ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const positiveRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type SessionShadowBudgetDecision =
  | { decision: "occupy_headroom"; reservedMicroUsd: string;
      amountMeaning: "cli_shadow_headroom_not_ceiling" }
  | { decision: "hold"; reason: "basis_invalid" | "price_unverified" |
      "non_token_cost_unbounded" | "usage_unknown" | "monthly_shadow_reached" };

export function assessSessionShadowBudget(raw: unknown): SessionShadowBudgetDecision {
  const hold = (reason: Extract<SessionShadowBudgetDecision,
    { decision: "hold" }>["reason"]): SessionShadowBudgetDecision =>
    ({ decision: "hold", reason });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return hold("basis_invalid");
  const keys = ["mode", "provider", "asOfIso", "pricingVerifiedAt", "pricingExpiresAt",
    "inputMicroUsdPerMillion", "outputMicroUsdPerMillion", "worstTierVerified",
    "billableToolsDisabled", "consumedMicroUsd", "reservedMicroUsd",
    "shadowOverrunMicroUsd", "monthlyLimitMicroUsd", "usageState"];
  let value: Record<string, unknown>;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        keys.some((key) => !("value" in (descriptors[key] ?? {})))) return hold("basis_invalid");
    value = Object.create(null) as Record<string, unknown>;
    for (const key of keys) value[key] = descriptors[key]!.value;
  } catch { return hold("basis_invalid"); }
  if (value.mode !== "subscription_cli" || !isAmuxIdeaAnalysisProvider(value.provider) ||
      !validInstant(value.asOfIso) || !validInstant(value.pricingVerifiedAt) ||
      !validInstant(value.pricingExpiresAt) ||
      !validAmount(value.consumedMicroUsd) || !validAmount(value.reservedMicroUsd) ||
      !validAmount(value.shadowOverrunMicroUsd) || !validAmount(value.monthlyLimitMicroUsd) ||
      BigInt(value.monthlyLimitMicroUsd) === BigInt(0) ||
      !positiveRate(value.inputMicroUsdPerMillion) ||
      !positiveRate(value.outputMicroUsdPerMillion) ||
      typeof value.worstTierVerified !== "boolean" ||
      typeof value.billableToolsDisabled !== "boolean" ||
      (value.usageState !== "known" && value.usageState !== "unknown")) return hold("basis_invalid");
  if (value.usageState === "unknown") return hold("usage_unknown");
  if (!value.billableToolsDisabled) return hold("non_token_cost_unbounded");
  if (!value.worstTierVerified || value.pricingVerifiedAt > value.asOfIso ||
      value.pricingExpiresAt <= value.asOfIso ||
      value.pricingExpiresAt <= value.pricingVerifiedAt) return hold("price_unverified");
  const used = BigInt(value.consumedMicroUsd) + BigInt(value.reservedMicroUsd) +
    BigInt(value.shadowOverrunMicroUsd);
  const limit = BigInt(value.monthlyLimitMicroUsd);
  if (used >= limit) return hold("monthly_shadow_reached");
  return { decision: "occupy_headroom", reservedMicroUsd: (limit - used).toString(),
    amountMeaning: "cli_shadow_headroom_not_ceiling" };
}

/** Measured API-equivalent cost is retained even when it exceeds the hold. */
export function settleSessionShadowUsage(raw: unknown):
  | { decision: "measured"; settledMicroUsd: string;
      boundedSpentMicroUsd: string; shadowOverrunMicroUsd: string }
  | { decision: "hold"; reason: "basis_invalid" | "usage_unknown" } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { decision: "hold", reason: "basis_invalid" };
  }
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).length !== 5 ||
      !validAmount(value.reservedMicroUsd) || BigInt(value.reservedMicroUsd) === BigInt(0) ||
      !positiveRate(value.inputMicroUsdPerMillion) ||
      !positiveRate(value.outputMicroUsdPerMillion)) {
    return { decision: "hold", reason: "basis_invalid" };
  }
  if (!Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens) ||
      (value.inputTokens as number) < 0 || (value.outputTokens as number) < 0 ||
      ((value.inputTokens as number) === 0 && (value.outputTokens as number) === 0)) {
    return { decision: "hold", reason: "usage_unknown" };
  }
  const ceil = (tokens: number, rate: number) =>
    (BigInt(tokens) * BigInt(rate) + BigInt(999999)) / BigInt(1000000);
  const settled = ceil(value.inputTokens as number, value.inputMicroUsdPerMillion as number) +
    ceil(value.outputTokens as number, value.outputMicroUsdPerMillion as number);
  const reserved = BigInt(value.reservedMicroUsd);
  if (settled > BigInt("9223372036854775807")) return { decision: "hold", reason: "basis_invalid" };
  return { decision: "measured", settledMicroUsd: settled.toString(),
    boundedSpentMicroUsd: (settled < reserved ? settled : reserved).toString(),
    shadowOverrunMicroUsd: (settled > reserved ? settled - reserved : BigInt(0)).toString() };
}
