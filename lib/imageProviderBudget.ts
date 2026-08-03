import { getDefaultBillingPlan } from "@/lib/billingPlanDefaults";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  listEnabledImagePricingEntries,
  maxRequestCostMicroUsd,
} from "@/lib/imageGenerationPricing";

// The image provider budget: a separate namespace from the chat budgets,
// with its own floor derivation. The chat floor comes from token-guardrail
// arithmetic (roughly US$500/month for a Max account); reusing it here would
// be 50x oversized, so the image floor derives from the image price list
// itself. Policy: docs/policy/image-generation.md section 8.
//
// resolveImageProviderBudget is pure (env injected) so the derivation is
// unit-testable with a fixed environment; the readiness wrapper lives in
// lib/imageProviderBudgetReadiness.ts because it reads the feature flag.

export const IMAGE_PROVIDER_BUDGET_ENV_NAMES = {
  day: "IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_DAY",
  month: "IMAGE_PROVIDER_OPENAI_COST_MICROUSD_PER_MONTH",
} as const;

export const IMAGE_BUDGET_HEADROOM_MULTIPLIER = 1.25;

/** Worst legitimate provider cost of one credit, prompt budget included. */
export const worstImageCostPerCreditMicroUsd = () =>
  Math.max(
    ...listEnabledImagePricingEntries().map((entry) =>
      Math.ceil(maxRequestCostMicroUsd(entry) / entry.credits)
    )
  );

/**
 * The smallest budget either window may enforce. One Max account may legally
 * spend its entire monthly credit grant in a single day, so the daily floor
 * equals the monthly floor -- an image budget below this would refuse
 * legitimate single-account traffic (policy section 8).
 * Current reference: 10,000 credits x 864 microUSD x 1.25 = US$10.80.
 */
export const imageProviderBudgetFloorMicroUsd = () => {
  const maxPlan = getDefaultBillingPlan("max");
  return Math.ceil(
    maxPlan.monthlyMessageLimit *
      worstImageCostPerCreditMicroUsd() *
      IMAGE_BUDGET_HEADROOM_MULTIPLIER
  );
};

/** Headroom left before the per-credit policy ceiling trips the pricing check. */
export const imageCostCeilingHeadroomMicroUsd = () =>
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD - worstImageCostPerCreditMicroUsd();

export type ImageProviderBudgetProblem = {
  window: "day" | "month";
  reason: "missing_in_production" | "not_a_positive_integer" | "partial_configuration";
  message: string;
};

export type ImageProviderBudgetClamp = {
  window: "day" | "month";
  configuredMicroUsd: number;
  effectiveMicroUsd: number;
};

export type ResolvedImageProviderBudget = {
  /** Effective enforced limits; null when the configuration is unusable. */
  limits: { day: number; month: number } | null;
  floorMicroUsd: number;
  problems: ImageProviderBudgetProblem[];
  /** Overrides raised to the floor -- reported, never silently applied. */
  clamped: ImageProviderBudgetClamp[];
  source: "environment" | "development_default" | "unconfigured";
};

const parseBudgetValue = (raw: string | undefined) => {
  if (raw === undefined || raw.trim() === "") return { state: "missing" as const };
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? { state: "valid" as const, value: parsed }
    : { state: "invalid" as const };
};

export const resolveImageProviderBudget = (
  env: Record<string, string | undefined> = process.env,
  options: { production?: boolean } = {}
): ResolvedImageProviderBudget => {
  const production = options.production ?? env.NODE_ENV === "production";
  const floor = imageProviderBudgetFloorMicroUsd();
  const problems: ImageProviderBudgetProblem[] = [];
  const clamped: ImageProviderBudgetClamp[] = [];

  const day = parseBudgetValue(env[IMAGE_PROVIDER_BUDGET_ENV_NAMES.day]);
  const month = parseBudgetValue(env[IMAGE_PROVIDER_BUDGET_ENV_NAMES.month]);

  if (day.state === "invalid" || month.state === "invalid") {
    for (const [window, parsed] of [
      ["day", day],
      ["month", month],
    ] as const) {
      if (parsed.state === "invalid") {
        problems.push({
          window,
          reason: "not_a_positive_integer",
          message: `${IMAGE_PROVIDER_BUDGET_ENV_NAMES[window]} must be a positive integer of micro-USD.`,
        });
      }
    }
    return { limits: null, floorMicroUsd: floor, problems, clamped, source: "unconfigured" };
  }

  if (day.state === "missing" && month.state === "missing") {
    if (production) {
      // No silent production default -- same contract as the chat provider
      // budgets (lib/providerCostBudget.ts). Deploy the variables first,
      // the flag second.
      for (const window of ["day", "month"] as const) {
        problems.push({
          window,
          reason: "missing_in_production",
          message: `${IMAGE_PROVIDER_BUDGET_ENV_NAMES[window]} is required in production.`,
        });
      }
      return { limits: null, floorMicroUsd: floor, problems, clamped, source: "unconfigured" };
    }
    // Development/test fallback, never below the floor so local behaviour
    // matches what production would enforce.
    return {
      limits: {
        day: Math.max(floor, 10_000_000),
        month: Math.max(floor, 100_000_000),
      },
      floorMicroUsd: floor,
      problems,
      clamped,
      source: "development_default",
    };
  }

  if (day.state === "missing" || month.state === "missing") {
    const missing = day.state === "missing" ? "day" : "month";
    problems.push({
      window: missing,
      reason: "partial_configuration",
      message: `${IMAGE_PROVIDER_BUDGET_ENV_NAMES[missing]} is missing while the other window is set; configure both.`,
    });
    return { limits: null, floorMicroUsd: floor, problems, clamped, source: "unconfigured" };
  }

  const effective = { day: day.value, month: month.value };
  for (const window of ["day", "month"] as const) {
    if (effective[window] < floor) {
      clamped.push({
        window,
        configuredMicroUsd: effective[window],
        effectiveMicroUsd: floor,
      });
      effective[window] = floor;
    }
  }

  return {
    limits: effective,
    floorMicroUsd: floor,
    problems,
    clamped,
    source: "environment",
  };
};
