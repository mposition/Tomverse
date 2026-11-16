import { isAmuxIdeaAnalysisProvider, type AmuxIdeaAnalysisProvider } from
  "./ideaAnalysisChannelCore.ts";

/** Subscription CLI analysis (v19) admission only: any of the four channels,
 * each on its subscription account (owner decision 2026-10-20). A subscription
 * call spends no money, so its shadow estimate is a record, never a stop
 * (operator, 2026-11-16): a claim reserves nothing of the monthly window and
 * runs beside any other claim, whatever the month's shadow total or another
 * claim's unknown outcome. Only a billable tool, whose cost is not a token
 * estimate, still holds. */
export type SessionShadowBudgetBasis = {
  mode: "subscription_cli";
  provider: AmuxIdeaAnalysisProvider;
  billableToolsDisabled: boolean;
};

const AMOUNT = /^(0|[1-9][0-9]*)$/;
const validAmount = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 19 && AMOUNT.test(value) &&
  BigInt(value) <= BigInt("9223372036854775807");
const positiveRate = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export type SessionShadowBudgetDecision =
  | { decision: "record_only"; reservedMicroUsd: "0";
      amountMeaning: "cli_shadow_record_only" }
  | { decision: "hold"; reason: "basis_invalid" | "non_token_cost_unbounded" };

export function assessSessionShadowBudget(raw: unknown): SessionShadowBudgetDecision {
  const hold = (reason: Extract<SessionShadowBudgetDecision,
    { decision: "hold" }>["reason"]): SessionShadowBudgetDecision =>
    ({ decision: "hold", reason });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return hold("basis_invalid");
  const keys = ["mode", "provider", "billableToolsDisabled"];
  let value: Record<string, unknown>;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        keys.some((key) => !("value" in (descriptors[key] ?? {})))) return hold("basis_invalid");
    value = Object.create(null) as Record<string, unknown>;
    for (const key of keys) value[key] = descriptors[key]!.value;
  } catch { return hold("basis_invalid"); }
  if (value.mode !== "subscription_cli" || !isAmuxIdeaAnalysisProvider(value.provider) ||
      typeof value.billableToolsDisabled !== "boolean") return hold("basis_invalid");
  if (!value.billableToolsDisabled) return hold("non_token_cost_unbounded");
  return { decision: "record_only", reservedMicroUsd: "0",
    amountMeaning: "cli_shadow_record_only" };
}

/** The closure of one outcome_unknown session claim. Positive proof that the
 * CLI never started releases the hold in either mode. Without that proof a
 * bounded claim consumes its full reservation (its API ceiling may have been
 * spent). A subscription (max_shadow) claim spends no money and what it held
 * is headroom, not usage: its shadow usage stays unknown and nothing is
 * counted as this month's usage (owner decision 2026-10-20). The owner closes
 * a bounded claim in Admin; the system closes a subscription claim the moment
 * its outcome is recorded unknown, with the same result as the owner's
 * "not proven" (operator, 2026-11-16). */
export type SessionUnknownResolution = {
  status: "released" | "owner_consumed";
  settledMicroUsd: string;
  spentIncrementMicroUsd: string;
  shadowUsage: "unknown" | null;
};

export function resolveSessionUnknownClaim(raw: unknown):
  | ({ decision: "resolve" } & SessionUnknownResolution)
  | { decision: "refuse" } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { decision: "refuse" };
  }
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).length !== 3 ||
      (value.budgetMode !== "bounded" && value.budgetMode !== "max_shadow") ||
      (value.verification !== "proven_not_started" &&
       value.verification !== "not_proven") ||
      !validAmount(value.reservedMicroUsd) ||
      // A subscription claim made since 2026-11-16 reserves nothing.
      (value.budgetMode === "bounded" && BigInt(value.reservedMicroUsd) === BigInt(0))) {
    return { decision: "refuse" };
  }
  if (value.verification === "proven_not_started") {
    return { decision: "resolve", status: "released", settledMicroUsd: "0",
      spentIncrementMicroUsd: "0", shadowUsage: null };
  }
  if (value.budgetMode === "max_shadow") {
    return { decision: "resolve", status: "owner_consumed", settledMicroUsd: "0",
      spentIncrementMicroUsd: "0", shadowUsage: "unknown" };
  }
  return { decision: "resolve", status: "owner_consumed",
    settledMicroUsd: value.reservedMicroUsd,
    spentIncrementMicroUsd: value.reservedMicroUsd, shadowUsage: null };
}

/** Measured API-equivalent cost is retained even when it exceeds the hold.
 * Whatever the claim reserved (nothing since 2026-11-16) is spent first; the
 * rest is the window's shadow total. A result whose CLI reported no tokens is
 * still a result: it settles at zero instead of being refused (operator,
 * 2026-11-16). */
export function settleSessionShadowUsage(raw: unknown):
  | { decision: "measured"; settledMicroUsd: string;
      boundedSpentMicroUsd: string; shadowOverrunMicroUsd: string }
  | { decision: "hold"; reason: "basis_invalid" | "usage_unknown" } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { decision: "hold", reason: "basis_invalid" };
  }
  const value = raw as Record<string, unknown>;
  if (Reflect.ownKeys(value).length !== 5 ||
      !validAmount(value.reservedMicroUsd) ||
      !positiveRate(value.inputMicroUsdPerMillion) ||
      !positiveRate(value.outputMicroUsdPerMillion)) {
    return { decision: "hold", reason: "basis_invalid" };
  }
  if (!Number.isSafeInteger(value.inputTokens) || !Number.isSafeInteger(value.outputTokens) ||
      (value.inputTokens as number) < 0 || (value.outputTokens as number) < 0) {
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
