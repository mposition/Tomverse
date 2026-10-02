/**
 * Dark, pure AMUX v4 analysis-Agent cost and failure admission. This is only a
 * necessary pre-call check: it neither reserves funds nor authorizes a CLI
 * spawn. A future app writer must load a version-pinned price and the current
 * agent/amux-intake ledger under a transaction, reserve the calculated maximum
 * atomically, and enforce the token caps in the isolated local runner. It must
 * also check the independent global halt state, call/day and hard deadlines,
 * current model approval, receipt, switches, and measured sandbox isolation.
 * On unknown usage, read-back or owner release must consume the pre-reserved
 * worst-case estimate; never settle it as zero. This core has no release path.
 * The writer takes asOfIso from its database clock. The local CLI exception
 * and dark code-drafting gate are recorded in docs/policy/amux-intake.md v12.
 */
export const AMUX_V4_ANALYSIS_NAMESPACE = "agent/amux-intake" as const;
export const AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD = "50000000" as const;

const TOKENS_PER_MILLION = BigInt(1_000_000);
const MONTHLY_CAP = BigInt(AMUX_V4_ANALYSIS_MONTHLY_CAP_MICROUSD);
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const OUTCOMES = new Set<string>([
  "preflight_refusal", "owner_cancelled", "verified_success",
  "invocation_failed", "outcome_unknown",
]);

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const snapshotExact = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  try {
    if (!record(value)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).length !== keys.length ||
        !keys.every((key) => "value" in (descriptors[key] ?? {}))) return null;
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys) snapshot[key] = descriptors[key].value;
    return snapshot;
  } catch {
    return null;
  }
};
const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 19 && DECIMAL.test(value) &&
  BigInt(value) <= BigInt("9223372036854775807");
const utcIso = (value: unknown): value is string =>
  typeof value === "string" && UTC_ISO.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const ceilDivide = (value: bigint, divisor: bigint) =>
  (value + divisor - BigInt(1)) / divisor;

export type AmuxIdeaAnalysisBudgetBasis = {
  namespace: typeof AMUX_V4_ANALYSIS_NAMESPACE;
  mode: "subscription_cli" | "api";
  provider: "openai" | "anthropic";
  modelId: string;
  pricingVersion: string;
  pricingVerifiedAt: string;
  /** From the approved catalog. No price is usable at or after this instant. */
  pricingExpiresAt: string;
  asOfIso: string;
  /** The ledger's UTC calendar-month start, not a caller-selected period. */
  windowStartsAtIso: string;
  /** Rates below cover the maximum applicable context/cache/region/tier price. */
  worstTierVerified: boolean;
  /** The runner must be able to enforce both caps, including reasoning output. */
  tokenCapsEnforceable: boolean;
  /** No billable tool or request-fixed charge may occur in this tool-less CLI. */
  billableToolsDisabled: boolean;
  /** Total of uncached, cache-read and cache-write input tokens. */
  inputTokensCap: number;
  /** Total output including reasoning tokens. */
  outputTokensCap: number;
  /** Maximum of uncached, cache-read and cache-write input, not uncached alone. */
  inputMicroUsdPerMillion: number;
  outputMicroUsdPerMillion: number;
  /** Current month, agent namespace only; includes failed calls. */
  consumedMicroUsd: string;
  reservedMicroUsd: string;
  usageState: "known" | "unknown";
};

export type AmuxIdeaAnalysisBudgetDecision =
  | { decision: "reservation_candidate"; namespace: typeof AMUX_V4_ANALYSIS_NAMESPACE;
      mode: "subscription_cli" | "api"; provider: "openai" | "anthropic"; modelId: string;
      worstCaseMicroUsd: string; remainingAfterMicroUsd: string; pricingVersion: string;
      windowStartsAtIso: string;
      amountMeaning: "api_price_reservation_ceiling" | "cli_api_conversion_estimate" }
  | { decision: "hold"; reason: "basis_invalid" | "price_unverified" |
      "caps_unenforceable" | "non_token_cost_unbounded" | "usage_unknown" |
      "monthly_cap_exceeded" };

export function assessAmuxIdeaAnalysisBudget(
  raw: unknown,
): AmuxIdeaAnalysisBudgetDecision {
  const hold = (reason: Extract<AmuxIdeaAnalysisBudgetDecision, { decision: "hold" }>["reason"]):
    AmuxIdeaAnalysisBudgetDecision => ({ decision: "hold", reason });
  const keys = ["namespace", "mode", "provider", "modelId", "pricingVersion",
    "pricingVerifiedAt", "pricingExpiresAt", "asOfIso", "windowStartsAtIso",
    "worstTierVerified", "tokenCapsEnforceable", "billableToolsDisabled",
    "inputTokensCap", "outputTokensCap", "inputMicroUsdPerMillion",
    "outputMicroUsdPerMillion", "consumedMicroUsd", "reservedMicroUsd", "usageState"];
  const value = snapshotExact(raw, keys);
  if (!value ||
      value.namespace !== AMUX_V4_ANALYSIS_NAMESPACE ||
      (value.mode !== "subscription_cli" && value.mode !== "api") ||
      (value.provider !== "openai" && value.provider !== "anthropic") ||
      typeof value.modelId !== "string" || !MODEL_ID.test(value.modelId) ||
      typeof value.pricingVersion !== "string" || !VERSION.test(value.pricingVersion) ||
      !utcIso(value.asOfIso) || !utcIso(value.pricingVerifiedAt) ||
      !utcIso(value.pricingExpiresAt) ||
      !utcIso(value.windowStartsAtIso) ||
      value.windowStartsAtIso !== `${value.asOfIso.slice(0, 7)}-01T00:00:00.000Z` ||
      !positiveSafeInteger(value.inputTokensCap) ||
      !positiveSafeInteger(value.outputTokensCap) ||
      !nonnegativeSafeInteger(value.inputMicroUsdPerMillion) ||
      !nonnegativeSafeInteger(value.outputMicroUsdPerMillion) ||
      !amount(value.consumedMicroUsd) || !amount(value.reservedMicroUsd) ||
      (value.usageState !== "known" && value.usageState !== "unknown") ||
      typeof value.worstTierVerified !== "boolean" ||
      typeof value.tokenCapsEnforceable !== "boolean" ||
      typeof value.billableToolsDisabled !== "boolean") return hold("basis_invalid");
  if (value.usageState === "unknown") return hold("usage_unknown");
  if (!value.tokenCapsEnforceable) return hold("caps_unenforceable");
  if (!value.billableToolsDisabled) return hold("non_token_cost_unbounded");
  if (!value.worstTierVerified || value.pricingVerifiedAt > value.asOfIso ||
      value.pricingExpiresAt <= value.asOfIso ||
      value.pricingExpiresAt <= value.pricingVerifiedAt ||
      !positiveSafeInteger(value.inputMicroUsdPerMillion) ||
      !positiveSafeInteger(value.outputMicroUsdPerMillion)) return hold("price_unverified");

  // Count all input at the maximum applicable rate across uncached, cache
  // writes/reads and context tiers. Discounts never reduce the reservation.
  // Round each category upward.
  const worstCase =
    ceilDivide(BigInt(value.inputTokensCap) * BigInt(value.inputMicroUsdPerMillion), TOKENS_PER_MILLION) +
    ceilDivide(BigInt(value.outputTokensCap) * BigInt(value.outputMicroUsdPerMillion), TOKENS_PER_MILLION);
  const outstanding = BigInt(value.consumedMicroUsd) + BigInt(value.reservedMicroUsd) + worstCase;
  if (outstanding > MONTHLY_CAP) return hold("monthly_cap_exceeded");
  return {
    decision: "reservation_candidate",
    namespace: AMUX_V4_ANALYSIS_NAMESPACE,
    mode: value.mode,
    provider: value.provider,
    modelId: value.modelId,
    worstCaseMicroUsd: worstCase.toString(),
    remainingAfterMicroUsd: (MONTHLY_CAP - outstanding).toString(),
    pricingVersion: value.pricingVersion,
    windowStartsAtIso: value.windowStartsAtIso,
    amountMeaning: value.mode === "subscription_cli"
      ? "cli_api_conversion_estimate" : "api_price_reservation_ceiling",
  };
}

export type AmuxIdeaAnalysisSettlementDecision =
  | { decision: "settlement_candidate"; status: "succeeded" | "failed";
      settledMicroUsd: string; releasedMicroUsd: string }
  | { decision: "hold"; reason: "basis_invalid" | "usage_unknown" |
      "usage_exceeds_cap" | "reservation_mismatch" };

/** A known provider result moves only the measured upper-bound estimate from
 * reserved to spent. This does not write either ledger. Unknown usage keeps
 * the full reservation occupied; release and owner resolution are separate
 * audited transactions, not inferred from a failed transport. */
export function assessAmuxIdeaAnalysisSettlement(raw: unknown):
  AmuxIdeaAnalysisSettlementDecision {
  const hold = (reason: Extract<AmuxIdeaAnalysisSettlementDecision,
    { decision: "hold" }>["reason"]): AmuxIdeaAnalysisSettlementDecision =>
    ({ decision: "hold", reason });
  const value = snapshotExact(raw, ["outcome", "reservedMicroUsd", "inputTokensCap",
    "outputTokensCap", "inputMicroUsdPerMillion", "outputMicroUsdPerMillion",
    "inputTokens", "outputTokens"]);
  if (!value || !amount(value.reservedMicroUsd) ||
      BigInt(value.reservedMicroUsd) === BigInt(0) ||
      !positiveSafeInteger(value.inputTokensCap) ||
      !positiveSafeInteger(value.outputTokensCap) ||
      !positiveSafeInteger(value.inputMicroUsdPerMillion) ||
      !positiveSafeInteger(value.outputMicroUsdPerMillion) ||
      (value.outcome !== "verified_success" &&
       value.outcome !== "invocation_failed" &&
       value.outcome !== "outcome_unknown")) return hold("basis_invalid");
  if (value.outcome === "outcome_unknown") {
    return value.inputTokens === null && value.outputTokens === null
      ? hold("usage_unknown") : hold("basis_invalid");
  }
  if (!nonnegativeSafeInteger(value.inputTokens) ||
      !nonnegativeSafeInteger(value.outputTokens) ||
      (value.inputTokens === 0 && value.outputTokens === 0)) return hold("basis_invalid");
  if (value.inputTokens > value.inputTokensCap ||
      value.outputTokens > value.outputTokensCap) return hold("usage_exceeds_cap");
  const settled =
    ceilDivide(BigInt(value.inputTokens) * BigInt(value.inputMicroUsdPerMillion), TOKENS_PER_MILLION) +
    ceilDivide(BigInt(value.outputTokens) * BigInt(value.outputMicroUsdPerMillion), TOKENS_PER_MILLION);
  const reserved = BigInt(value.reservedMicroUsd);
  if (settled > reserved) return hold("reservation_mismatch");
  return { decision: "settlement_candidate",
    status: value.outcome === "verified_success" ? "succeeded" : "failed",
    settledMicroUsd: settled.toString(),
    releasedMicroUsd: (reserved - settled).toString() };
}

export type AmuxIdeaAnalysisFailureState = {
  consecutiveFailures: number;
  haltReason: null | "three_failures" | "outcome_unknown";
};

export type AmuxIdeaAnalysisOutcome =
  "preflight_refusal" | "owner_cancelled" | "verified_success" |
  "invocation_failed" | "outcome_unknown";

/** Release is intentionally absent: it needs owner step-up and human audit. */
export function advanceAmuxIdeaAnalysisFailureState(
  current: AmuxIdeaAnalysisFailureState,
  outcome: AmuxIdeaAnalysisOutcome,
): AmuxIdeaAnalysisFailureState | null {
  const state = snapshotExact(current, ["consecutiveFailures", "haltReason"]);
  if (!OUTCOMES.has(outcome) || !state ||
      !Number.isSafeInteger(state.consecutiveFailures) ||
      (state.consecutiveFailures as number) < 0 || (state.consecutiveFailures as number) > 3 ||
      (state.haltReason !== null && state.haltReason !== "three_failures" &&
        state.haltReason !== "outcome_unknown") ||
      (state.haltReason === "three_failures" && state.consecutiveFailures !== 3) ||
      (state.haltReason === "outcome_unknown" && state.consecutiveFailures === 3) ||
      (state.haltReason === null && state.consecutiveFailures === 3)) return null;
  const consecutiveFailures = state.consecutiveFailures as number;
  const haltReason = state.haltReason as AmuxIdeaAnalysisFailureState["haltReason"];
  if (haltReason !== null) {
    // An invocation result after a halt is an incident, not a state update.
    // The caller must stop and report null through canonical audit.
    return outcome === "preflight_refusal" || outcome === "owner_cancelled"
      ? { consecutiveFailures, haltReason } : null;
  }
  if (outcome === "preflight_refusal" || outcome === "owner_cancelled") {
    return { consecutiveFailures, haltReason };
  }
  if (outcome === "verified_success") return { consecutiveFailures: 0, haltReason: null };
  if (outcome === "outcome_unknown") {
    return { consecutiveFailures, haltReason: "outcome_unknown" };
  }
  if (outcome === "invocation_failed") {
    const nextFailures = consecutiveFailures + 1;
    return { consecutiveFailures: nextFailures,
      haltReason: nextFailures >= 3 ? "three_failures" : null };
  }
  return null;
}
