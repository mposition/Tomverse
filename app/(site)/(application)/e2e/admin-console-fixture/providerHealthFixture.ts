import type {
  ProviderHealthDashboard,
  ProviderHealthRow,
} from "@/lib/providerMonitoring";

// STG-R002 fixture for the Provider Health panel's verification and recovery
// controls.
//
// The panel decides what to enable from the provider's public status, its
// consecutive-failure count and the last verification result -- so a fixture
// has to be able to state all three independently. Everything else on
// ProviderHealthRow is cost and billing detail those controls never read; it is
// filled with neutral values here rather than omitted, so the row stays the
// real type and a field added to it later fails the build instead of silently
// arriving as undefined at runtime.

const BASE_ROW: ProviderHealthRow = {
  provider: "perplexity",
  displayName: "Perplexity",
  apiKeyConfigured: true,
  status: "available",
  statusReasons: [
    {
      code: "HEALTHY",
      title: "No limiting condition is active",
      detail: "Fixture row.",
    },
  ],
  successCount24h: 0,
  failureCount24h: 5,
  successRate24h: 0,
  healthWindowMinutes: 15,
  windowSuccessCount: 0,
  windowFailureCount: 0,
  windowFailureRatePercent: null,
  consecutiveSuccesses: 0,
  recentErrorCode: "DEEP_RESEARCH_SUBMIT_FAILED.HTTP_400",
  recentErrors: [],
  recentErrorEvents: [],
  lastSuccessAt: null,
  lastFailureAt: "2026-07-30T22:00:00.000Z",
  consecutiveFailures: 5,
  lastProbeSuccessAt: null,
  lastProbeFailureAt: null,
  consecutiveProbeFailures: 0,
  publicStatus: "incident",
  publicStatusReasonCode: "CONSECUTIVE_FAILURES_THRESHOLD",
  publicStatusReasonText:
    "5 consecutive requests have failed since the last recorded success.",
  publicStatusIsFresh: false,
  publicStatusFreshnessMinutes: 30,
  todayCostMicroUsd: 0,
  monthCostMicroUsd: 0,
  providerReportedMonthCostMicroUsd: null,
  usageVariancePercent: null,
  usageSource: "internal",
  lastUsageSyncAt: null,
  monthBudgetMicroUsd: 100_000_000,
  dayBudgetMicroUsd: 10_000_000,
  budgetUsagePercent: 0,
  balanceUsd: null,
  balanceAmount: null,
  balanceCurrency: "USD",
  balanceAvailable: null,
  balanceGrantedAmount: null,
  balanceToppedUpAmount: null,
  balanceSource: "unavailable",
  credit: {
    configuredCreditMicroUsd: null,
    usedSinceCheckpointMicroUsd: 0,
    estimatedBalanceMicroUsd: null,
    checkpointAt: null,
    note: null,
  },
  creditRemainingPercent: null,
  creditAlertLevel: "none",
  billingProfile: {
    pricingModel: "usage_based",
    settlementModel: "prepaid",
    source: "documented_default",
    currency: "USD",
    monthlyLimitMicroUsd: null,
    verifiedAt: null,
    note: null,
    isPersisted: false,
  },
  projectedMonthEndMicroUsd: 0,
  internalBudgetSource: "code_default",
  providerBillingHeadroomMicroUsd: null,
  internalBudgetHeadroomMicroUsd: 100_000_000,
  expectedEffectiveCeilingMicroUsd: 100_000_000,
  expectedEffectiveHeadroomMicroUsd: 100_000_000,
  limitAlignment: "provider_not_configured",
  alertLevel: "none",
  fallback: {
    reason: "Search provider fallback",
    recommendedModelIds: ["gpt-5-4-mini"],
  },
  modelIncidents: [],
  lastVerificationSuccessAt: null,
  lastVerificationFailureAt: null,
  lastRecoveryAt: null,
  verificationModelId: "perplexity/sonar",
};

export type ProviderHealthFixtureState =
  /** Blocked by consecutive failures, no verification run yet. */
  | "incident"
  /** Healthy provider: nothing to recover. */
  | "operational"
  /** Blocked, but this deployment has no model to verify with. */
  | "noVerificationModel";

const STATES: Record<ProviderHealthFixtureState, ProviderHealthRow> = {
  incident: BASE_ROW,
  operational: {
    ...BASE_ROW,
    status: "available",
    consecutiveFailures: 0,
    lastSuccessAt: "2026-08-01T07:50:00.000Z",
    lastFailureAt: null,
    recentErrorCode: null,
    failureCount24h: 0,
    publicStatus: "operational",
    publicStatusReasonCode: "RECENT_SUCCESS_CONFIRMED",
    publicStatusReasonText:
      "A successful request was recorded within the last 30 minutes.",
    publicStatusIsFresh: true,
  },
  noVerificationModel: { ...BASE_ROW, verificationModelId: null },
};

export const providerHealthFixture = (
  state: ProviderHealthFixtureState
): ProviderHealthDashboard => ({
  generatedAt: "2026-08-01T08:00:00.000Z",
  providers: [STATES[state] ?? STATES.incident],
  tierLimits: { Free: "shared", Pro: "shared", Max: "shared" },
  notificationChannels: { email: false, slack: false, discord: false },
  probeCostTodayMicroUsd: 0,
  probeCostCapMicroUsd: 1_000_000,
});

export const PROVIDER_HEALTH_FIXTURE_STATES: ProviderHealthFixtureState[] = [
  "incident",
  "operational",
  "noVerificationModel",
];
