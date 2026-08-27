/**
 * The operational spend budget for the search vendors this application calls
 * itself.
 *
 * ## Why it is not the chat provider budget
 *
 * `lib/providerCostBudget.ts` bounds what one *model provider* may be paid for
 * tokens. A Brave request is not tokens, is not billed by Google, and does not
 * appear on Google's invoice -- so counting a Gemini turn's Brave spend against
 * `provider:google` would make one vendor's outage look like another's
 * overspend, and would let a search-heavy day exhaust the budget that exists to
 * stop a *model* cost running away. The two are separate invoices and get
 * separate buckets, separate environment variables, and separate error scopes.
 *
 * It is also not an entitlement. What a user is allowed to search is decided by
 * credits -- the eight-credit web-search surcharge, reserved and refunded per
 * model per turn. This is the operational layer underneath that: a global cap
 * shared by everybody, which exists so a runaway loop or an abusive account
 * cannot spend the search vendor's invoice into the ground before anyone
 * notices. `docs/policy/credit-and-cost-limits.md` keeps those two layers from
 * borrowing each other's names, and this module keeps its own: bucket
 * `search-provider:<backend>`, env `SEARCH_PROVIDER_<BACKEND>_COST_MICROUSD_PER_*`,
 * error code `SEARCH_PROVIDER_BUDGET_EXHAUSTED`.
 *
 * ## Why the floor is derived rather than chosen
 *
 * The chat floor is the largest single-account plan guardrail, roughly
 * US$500/month. Reusing it here would be a budget twelve times larger than
 * anything search can legitimately spend, which is not a bound at all. The
 * image budget already ran into the same problem and answered it by deriving
 * its floor from the image price list; this derives from the credit price of a
 * searching turn, which is the only thing that actually rations search:
 *
 *   Max plan monthly credits / credits per searching model-turn
 *     x worst-case backend cost per model-turn
 *     x headroom
 *
 * Today: 10,000 / 8 x 25,000 microUSD x 1.25 = 39,062,500 microUSD, about
 * US$39.06. A budget below that would refuse one legitimate Max account
 * spending its own entitlement on search -- which is the incoherence the
 * provider-budget contract exists to forbid, one layer down.
 *
 * The day floor equals the month floor, and deliberately. The Max plan carries
 * no daily credit limit (`dailyMessageLimit: 0`), so one account may legally
 * spend its whole monthly grant in a single day; a daily floor below the
 * monthly one would refuse that day's traffic while the month was untouched.
 * The image budget's floor is the same shape for the same reason.
 *
 * Pure and environment-injected, so the derivation is unit-testable against a
 * fixed environment. The readiness wrapper lives in
 * `lib/searchProviderBudgetReadiness.ts`.
 */

import { getDefaultBillingPlan } from "@/lib/billingPlanDefaults";
import {
  APP_MANAGED_SEARCH_LIMITS,
  WEB_SEARCH_BACKENDS,
  type WebSearchBackend,
} from "@/lib/webSearchBackends";
import { searchBackendWorstCaseCostMicroUsd } from "@/lib/webSearchBackendPricing";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "@/lib/webSearchCredits";

export type SearchProviderBudgetPeriod = "day" | "month";

/**
 * The `ChatUsageBucket."key"` a search backend's spend is counted under.
 *
 * Its own prefix rather than `provider:`, because the settlement paths key off
 * that prefix to decide what a provider's bucket settles to -- a search bucket
 * that shared it would be handed a model provider's cost and would settle to
 * the wrong number without anything failing.
 */
export const SEARCH_PROVIDER_BUCKET_PREFIX = "search-provider:";

export const searchProviderBucketKey = (backend: string) =>
  `${SEARCH_PROVIDER_BUCKET_PREFIX}${backend}`;

/** The `ChatUsageBucket."period"` values a search budget hold is written under. */
export const SEARCH_PROVIDER_BUDGET_PERIODS = [
  "search-cost-day",
  "search-cost-month",
] as const;

export type SearchProviderBudgetBucketPeriod =
  (typeof SEARCH_PROVIDER_BUDGET_PERIODS)[number];

export const searchProviderBudgetEnvName = (
  backend: string,
  period: SearchProviderBudgetPeriod
) =>
  `SEARCH_PROVIDER_${backend.toUpperCase()}_COST_MICROUSD_PER_${period.toUpperCase()}`;

/** Development and test only. Never applied in production -- readiness refuses. */
export const DEVELOPMENT_SEARCH_PROVIDER_BUDGET_MICRO_USD = {
  day: 5_000_000,
  month: 50_000_000,
} as const;

export const SEARCH_BUDGET_HEADROOM_MULTIPLIER = 1.25;

/**
 * The most one model's search may cost this application in one turn.
 *
 * The same product the reservation writes down, computed from the same two
 * fields, so the floor cannot be derived from a ceiling the dispatch does not
 * enforce.
 */
export const worstSearchCostPerModelTurnMicroUsd = (
  backend: WebSearchBackend
): number => {
  const worst = searchBackendWorstCaseCostMicroUsd(
    backend,
    APP_MANAGED_SEARCH_LIMITS.maxQueriesPerRequest
  );
  if (worst === undefined) {
    // A backend in the register with no price is a configuration this module
    // cannot answer for. Throwing rather than skipping: skipping would derive
    // a floor from the backends that happen to be priced and quietly leave the
    // expensive one uncovered, which is the failure mode the image budget's
    // own throw was added for.
    throw new Error(
      `${backend} has no search backend price, so no search provider budget floor can be derived.`
    );
  }
  return worst;
};

/**
 * The smallest budget either window may enforce, for one backend.
 *
 * See the header: one Max account's whole monthly credit grant, spent entirely
 * on searching turns, at the worst case each one may cost.
 */
export const searchProviderBudgetFloorMicroUsd = (
  backend: WebSearchBackend
): number => {
  const maxPlan = getDefaultBillingPlan("max");
  const searchingTurns = Math.ceil(
    maxPlan.monthlyMessageLimit / WEB_SEARCH_SURCHARGE_CREDITS
  );
  return Math.ceil(
    searchingTurns *
      worstSearchCostPerModelTurnMicroUsd(backend) *
      SEARCH_BUDGET_HEADROOM_MULTIPLIER
  );
};

export type SearchProviderBudgetProblem = {
  backend: WebSearchBackend;
  window: SearchProviderBudgetPeriod;
  reason:
    | "missing_in_production"
    | "not_a_positive_integer"
    | "partial_configuration";
  envName: string;
  message: string;
};

export type SearchProviderBudgetAdvisory = {
  backend: WebSearchBackend;
  code: "month_not_above_day";
  message: string;
};

export type SearchProviderBudgetClamp = {
  window: SearchProviderBudgetPeriod;
  configuredMicroUsd: number;
  effectiveMicroUsd: number;
};

export type ResolvedSearchProviderBudget = {
  backend: WebSearchBackend;
  /** Effective enforced limits; null when the configuration is unusable. */
  limits: { day: number; month: number } | null;
  floorMicroUsd: number;
  problems: SearchProviderBudgetProblem[];
  advisories: SearchProviderBudgetAdvisory[];
  /** Overrides raised to the floor -- reported, never silently applied. */
  clamped: SearchProviderBudgetClamp[];
  source: "environment" | "development_default" | "unconfigured";
};

const parseBudgetValue = (raw: string | undefined) => {
  if (raw === undefined || raw.trim() === "") return { state: "missing" as const };
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? { state: "valid" as const, value: parsed }
    : { state: "invalid" as const };
};

export const resolveSearchProviderBudget = (
  backend: WebSearchBackend,
  env: Record<string, string | undefined> = process.env,
  options: { production?: boolean } = {}
): ResolvedSearchProviderBudget => {
  const production = options.production ?? env.NODE_ENV === "production";
  const floor = searchProviderBudgetFloorMicroUsd(backend);
  const envNames = {
    day: searchProviderBudgetEnvName(backend, "day"),
    month: searchProviderBudgetEnvName(backend, "month"),
  } as const;
  const problems: SearchProviderBudgetProblem[] = [];
  const advisories: SearchProviderBudgetAdvisory[] = [];
  const clamped: SearchProviderBudgetClamp[] = [];

  const day = parseBudgetValue(env[envNames.day]);
  const month = parseBudgetValue(env[envNames.month]);

  const unusable = (): ResolvedSearchProviderBudget => ({
    backend,
    limits: null,
    floorMicroUsd: floor,
    problems,
    advisories,
    clamped,
    source: "unconfigured",
  });

  if (day.state === "invalid" || month.state === "invalid") {
    for (const [window, parsed] of [
      ["day", day],
      ["month", month],
    ] as const) {
      if (parsed.state === "invalid") {
        problems.push({
          backend,
          window,
          reason: "not_a_positive_integer",
          envName: envNames[window],
          message: `${envNames[window]} must be a positive integer of micro-USD.`,
        });
      }
    }
    return unusable();
  }

  if (day.state === "missing" && month.state === "missing") {
    if (production) {
      // No silent production default, on the same contract as the chat and
      // image provider budgets: deploy the variables first, the backend key
      // second. A production process that inherited a number nobody chose is
      // a global cap nobody reviewed.
      for (const window of ["day", "month"] as const) {
        problems.push({
          backend,
          window,
          reason: "missing_in_production",
          envName: envNames[window],
          message: `${envNames[window]} is required in production while an application-managed search backend is configured.`,
        });
      }
      return unusable();
    }
    return {
      backend,
      limits: {
        day: Math.max(floor, DEVELOPMENT_SEARCH_PROVIDER_BUDGET_MICRO_USD.day),
        month: Math.max(
          floor,
          DEVELOPMENT_SEARCH_PROVIDER_BUDGET_MICRO_USD.month
        ),
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
      backend,
      window: missing,
      reason: "partial_configuration",
      envName: envNames[missing],
      message: `${envNames[missing]} is missing while the other window is set; configure both.`,
    });
    return unusable();
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

  if (effective.month <= effective.day) {
    advisories.push({
      backend,
      code: "month_not_above_day",
      message:
        `${envNames.month} (${effective.month}) is not above ${envNames.day} ` +
        `(${effective.day}): one day spent at the daily cap exhausts the ` +
        `month, so the monthly window adds no second bound.`,
    });
  }

  return {
    backend,
    limits: effective,
    floorMicroUsd: floor,
    problems,
    advisories,
    clamped,
    source: "environment",
  };
};

/**
 * Every backend that could actually receive a request from this deployment.
 *
 * `configuredBackends` is what the runtime says it holds credentials for, not
 * what the register declares. A backend nobody has a key for cannot be called,
 * so demanding its budget would block a deploy over spend that cannot happen --
 * the same rule the image budget applies to a provider whose models are all on
 * hold.
 */
export const resolveActiveSearchProviderBudgets = (
  configuredBackends: readonly WebSearchBackend[],
  env: Record<string, string | undefined> = process.env,
  options: { production?: boolean } = {}
): ResolvedSearchProviderBudget[] =>
  WEB_SEARCH_BACKENDS.filter((backend) =>
    configuredBackends.includes(backend)
  ).map((backend) => resolveSearchProviderBudget(backend, env, options));
