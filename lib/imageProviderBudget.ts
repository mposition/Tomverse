import { getDefaultBillingPlan } from "@/lib/billingPlanDefaults";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  listEnabledImagePricingEntries,
  maxRequestCostMicroUsd,
  type ImageGenerationPricingEntry,
} from "@/lib/imageGenerationPricing";
import {
  listActiveImageProviders,
  listEnabledImageModels,
  maxImageRequestCostMicroUsd,
  type ImageModelProfile,
  type ImageModelProvider,
} from "@/lib/imageModelRegistry";

// The image provider budget: a separate namespace from the chat budgets,
// with its own floor derivation. The chat floor comes from token-guardrail
// arithmetic (roughly US$500/month for a Max account); reusing it here would
// be 50x oversized, so the image floor derives from the image price list
// itself. Policy: docs/policy/image-generation.md section 8.
//
// resolveImageProviderBudget is pure (env injected) so the derivation is
// unit-testable with a fixed environment; the readiness wrapper lives in
// lib/imageProviderBudgetReadiness.ts because it reads the feature flag.

// Budgets are per PROVIDER, never per model (policy v2 section 8): several
// models on one account draw from one spend pool, and splitting the pool by
// model would refuse traffic while the provider's own budget is untouched.
// Model-level cost stays an observation dimension.
export const imageProviderBudgetEnvNames = (provider: ImageModelProvider) => {
  const namespace = provider.toUpperCase();
  return {
    day: `IMAGE_PROVIDER_${namespace}_COST_MICROUSD_PER_DAY`,
    month: `IMAGE_PROVIDER_${namespace}_COST_MICROUSD_PER_MONTH`,
  } as const;
};

/** Kept for the OpenAI-only call sites that predate the multi-provider split. */
export const IMAGE_PROVIDER_BUDGET_ENV_NAMES = imageProviderBudgetEnvNames("openai");

export const IMAGE_BUDGET_HEADROOM_MULTIPLIER = 1.25;

/**
 * Worst legitimate provider cost of one credit, prompt budget included, across
 * everything a user can buy today.
 *
 * Both price lists, because there are two. `IMAGE_GENERATION_PRICING` is
 * gpt-image-2's original table; every model added since carries its prices on
 * its registry profile. Reading only the first was right when it was the only
 * one and quietly stopped being: xAI shipped enabled and never entered this
 * derivation, and a Google model would not have either. The number it returned
 * stayed correct by luck -- gpt-image-2 Final happens to be the most expensive
 * credit on offer -- which is the kind of correctness that ends without
 * warning, on the deploy that adds a costlier model.
 *
 * An enabled model whose worst case is unknown throws rather than being
 * skipped. Skipping it would understate the floor using the very models the
 * floor exists to cover; `check:image-pricing` already forbids enabling one,
 * so this is the in-process backstop for a registry edit that gets past it.
 */
export const worstImageCostPerCreditFrom = (
  entries: readonly ImageGenerationPricingEntry[],
  models: readonly ImageModelProfile[]
): number => {
  const fromLegacyTable = entries.map((entry) =>
    Math.ceil(maxRequestCostMicroUsd(entry) / entry.credits)
  );
  const fromRegistry = models.flatMap((model) =>
    model.prices.map((price) => {
      const maxCost = maxImageRequestCostMicroUsd(model, price);
      if (maxCost === null) {
        throw new Error(
          `${model.id} is enabled but its worst-case cost is unbounded, so no ` +
            "image provider budget floor can be derived."
        );
      }
      return Math.ceil(maxCost / price.credits);
    })
  );
  return Math.max(...fromLegacyTable, ...fromRegistry);
};

/** The same derivation over what is actually enabled right now. */
export const worstImageCostPerCreditMicroUsd = () =>
  worstImageCostPerCreditFrom(
    listEnabledImagePricingEntries(),
    listEnabledImageModels()
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

/**
 * A configuration that is legal but says something the operator probably did
 * not mean. Separate from `problems` on purpose: a problem sets `limits` to
 * null and refuses readiness, and refusing to start over a merely odd budget
 * would be worse than the budget. These surface and do not block.
 */
export type ImageProviderBudgetAdvisory = {
  code: "month_not_above_day";
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
  /** Legal but probably unintended. Surfaces; never blocks readiness. */
  advisories: ImageProviderBudgetAdvisory[];
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
  options: { production?: boolean; provider?: ImageModelProvider } = {}
): ResolvedImageProviderBudget => {
  const production = options.production ?? env.NODE_ENV === "production";
  const provider = options.provider ?? "openai";
  const envNames = imageProviderBudgetEnvNames(provider);
  const floor = imageProviderBudgetFloorMicroUsd();
  const problems: ImageProviderBudgetProblem[] = [];
  const advisories: ImageProviderBudgetAdvisory[] = [];
  const clamped: ImageProviderBudgetClamp[] = [];

  const day = parseBudgetValue(env[envNames.day]);
  const month = parseBudgetValue(env[envNames.month]);

  if (day.state === "invalid" || month.state === "invalid") {
    for (const [window, parsed] of [
      ["day", day],
      ["month", month],
    ] as const) {
      if (parsed.state === "invalid") {
        problems.push({
          window,
          reason: "not_a_positive_integer",
          message: `${envNames[window]} must be a positive integer of micro-USD.`,
        });
      }
    }
    return {
      limits: null,
      floorMicroUsd: floor,
      problems,
      advisories,
      clamped,
      source: "unconfigured",
    };
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
          message: `${envNames[window]} is required in production.`,
        });
      }
      return {
      limits: null,
      floorMicroUsd: floor,
      problems,
      advisories,
      clamped,
      source: "unconfigured",
    };
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
      advisories,
      clamped,
      source: "development_default",
    };
  }

  if (day.state === "missing" || month.state === "missing") {
    const missing = day.state === "missing" ? "day" : "month";
    problems.push({
      window: missing,
      reason: "partial_configuration",
      message: `${envNames[missing]} is missing while the other window is set; configure both.`,
    });
    return {
      limits: null,
      floorMicroUsd: floor,
      problems,
      advisories,
      clamped,
      source: "unconfigured",
    };
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

  // Both windows being at or near the same number is legal and almost never
  // intended: a month equal to the day ceiling is exhausted by one day spent
  // at the cap, so the monthly window stops being a second bound at all. It is
  // deliberate in staging, where a small identical pair caps total spend; in
  // production it usually means one of the two was copied.
  if (effective.month <= effective.day) {
    advisories.push({
      code: "month_not_above_day",
      message:
        `${envNames.month} (${effective.month}) is not above ${envNames.day} ` +
        `(${effective.day}): one day spent at the daily cap exhausts the ` +
        `month, so the monthly window adds no second bound.`,
    });
  }

  return {
    limits: effective,
    floorMicroUsd: floor,
    problems,
    advisories,
    clamped,
    source: "environment",
  };
};

export type ResolvedImageProviderBudgetByProvider = {
  provider: ImageModelProvider;
  resolved: ResolvedImageProviderBudget;
};

/**
 * Every provider that has at least one ENABLED model must have a usable
 * budget. A provider whose models are all on hold is not checked: it cannot
 * receive a request, so demanding its budget would block a deploy over spend
 * that cannot happen (policy section 8).
 */
export const resolveActiveImageProviderBudgets = (
  env: Record<string, string | undefined> = process.env,
  options: { production?: boolean } = {}
): ResolvedImageProviderBudgetByProvider[] =>
  listActiveImageProviders().map((provider) => ({
    provider,
    resolved: resolveImageProviderBudget(env, { ...options, provider }),
  }));
