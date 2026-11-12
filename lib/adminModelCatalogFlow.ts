// The image catalogue's guided flow, as pure functions the panel and its tests
// share: which step a model is on, what that step asks the operator to do,
// how a server reason reads, and which edited credits can be applied.
// Deciding whether a model may serve stays on the server (lib/modelCatalogCore.ts);
// these only describe what the server reported.
import type { AdminFlowStepState } from "@/lib/adminAmuxFlow";

export type ImageOptionPrice = { quality: string; size: string; credits: number; outputCostMicroUsd: number };
export type ImageOptionFloor = { quality: string; size: string; floor: number | null };
export type ImageDraftReview = { floors: ImageOptionFloor[]; reasons: string[] };
export type ImageDraft = {
  pricingVersion: string;
  prices: ImageOptionPrice[];
  verification: { verifiedAt: string; sources: string[]; thinkingCapMicroUsd: number | null };
};
export type Admission = { admitted: boolean; reasons?: string[] };

/** One image model as the list and the detail view need it, served or not. */
export type ImageCatalogItem = {
  id: string;
  name: string;
  provider: string;
  apiModelId: string;
  source: "code" | "catalog";
  sizes: string[];
  qualities: string[];
  /** Null until the model resolves (a runtime model with no price yet). */
  served: null | {
    enabled: boolean | null;
    holdReason: string | null;
    disabledReason: string | null;
    pricingVersion: string;
    prices: ImageOptionPrice[];
    floors: ImageOptionFloor[];
    priceVerification: { verifiedAt: string | null; sources: string[]; thinkingCapMicroUsd: number | null };
    admissionIfEnabled: Admission;
  };
  problem: string | null;
  draft: ImageDraft | null;
  draftCreatedAt: string | null;
  draftReview: ImageDraftReview | null;
  /** The stored row, for the advanced view. */
  raw: unknown;
};

export type ImageStage =
  | "profile_invalid"
  | "needs_draft"
  | "draft_ready"
  | "ready_to_enable"
  | "blocked"
  | "needs_budget"
  | "serving"
  | "held";

export const imageStage = (item: ImageCatalogItem): ImageStage => {
  if (!item.served) {
    if (item.problem === "invalid_full_profile") return "profile_invalid";
    return item.draft ? "draft_ready" : "needs_draft";
  }
  const served = item.served;
  if (served.holdReason || served.enabled === false) return item.draft ? "draft_ready" : "held";
  if (served.disabledReason === null) return item.draft ? "draft_ready" : "serving";
  if (item.draft) return "draft_ready";
  if (served.admissionIfEnabled.admitted) return "ready_to_enable";
  // Only the provider budget is missing: the prices are fine and a new draft
  // would not help; the budget is set in the environment, not on this screen.
  const reasons = served.admissionIfEnabled.reasons ?? [];
  return reasons.length > 0 && reasons.every((reason) => reason === "provider_budget_missing") ? "needs_budget" : "blocked";
};

/**
 * Models that wait for the operator are listed apart from the settled ones:
 * a model added here until it serves, and any model with a draft to check. A
 * code model that is off is the code's decision (an unbounded worst case, say),
 * not a step the operator owes, so it stays in the table with its state.
 */
export const needsAction = (item: Pick<ImageCatalogItem, "source" | "draft">, stage: ImageStage) =>
  stage === "draft_ready" || (item.source === "catalog" && stage !== "serving" && stage !== "held");

export const IMAGE_FLOW_STEPS = ["profile", "draft", "review", "enable"] as const;
export type ImageFlowStep = (typeof IMAGE_FLOW_STEPS)[number];

const STEP_STATES: Record<ImageStage, AdminFlowStepState[]> = {
  profile_invalid: ["attention", "todo", "todo", "todo"],
  needs_draft: ["done", "current", "todo", "todo"],
  draft_ready: ["done", "done", "current", "todo"],
  blocked: ["done", "done", "attention", "todo"],
  needs_budget: ["done", "done", "done", "attention"],
  ready_to_enable: ["done", "done", "done", "current"],
  serving: ["done", "done", "done", "done"],
  held: ["done", "done", "done", "attention"],
};

export const imageFlowSteps = (stage: ImageStage) =>
  IMAGE_FLOW_STEPS.map((id, index) => ({ id, state: STEP_STATES[stage][index] }));

/** The one action each stage offers as its primary button. */
export type ImageNextAction = "fix_profile" | "make_draft" | "review_prices" | "enable" | "redraft" | "view" | "none";
export const imageNextAction = (stage: ImageStage): ImageNextAction =>
  ({
    profile_invalid: "fix_profile",
    needs_draft: "make_draft",
    draft_ready: "review_prices",
    ready_to_enable: "enable",
    blocked: "redraft",
    needs_budget: "none",
    serving: "view",
    held: "view",
  })[stage] as ImageNextAction;

/**
 * A server reason or error code as a message key and its parameters, so the
 * screen reads in words. Unknown codes fall back to "unknown" with the code,
 * shown only in the advanced view.
 */
export type ReasonMessage =
  | { key: "invalidProfile" }
  | { key: "noPrice" }
  | { key: "priceUnverified" }
  | { key: "unofficialSource"; host: string }
  | { key: "creditsBelowFloor"; quality: string; size: string }
  | { key: "worstCaseUnbounded" }
  | { key: "thinkingCapBelowMinimum"; minimum: string }
  | { key: "providerBudgetMissing" }
  | { key: "draftLlmOff" }
  | { key: "noDefaultSource" }
  | { key: "noPriceFound"; detail: string }
  | { key: "versionReused" }
  | { key: "profilePriced" }
  | { key: "invalidInput" }
  | { key: "fetchFailed" }
  | { key: "noDraft" }
  | { key: "rateLimited" }
  | { key: "forbidden" }
  | { key: "timeout" }
  | { key: "network" }
  | { key: "sessionExpired" }
  | { key: "unknown"; code: string };

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

export const reasonMessage = (code: string, detail = ""): ReasonMessage => {
  const [head, ...rest] = code.split(":");
  const tail = rest.join(":");
  switch (head) {
    case "invalid_full_profile":
    case "invalid_profile":
      return { key: "invalidProfile" };
    case "no_price_revision":
    case "no_prices":
    case "unknown_model_or_no_price_revision":
      return { key: "noPrice" };
    case "price_unverified":
    case "no_price_sources":
      return { key: "priceUnverified" };
    case "unofficial_source":
      return { key: "unofficialSource", host: hostOf(tail || detail) };
    case "credits_below_floor": {
      const [quality = "", size = ""] = tail.split("/");
      return { key: "creditsBelowFloor", quality, size };
    }
    case "worst_case_cost_unbounded":
      return { key: "worstCaseUnbounded" };
    case "thinking_cap_below_minimum":
      return { key: "thinkingCapBelowMinimum", minimum: tail };
    case "provider_budget_missing":
      return { key: "providerBudgetMissing" };
    case "draft_llm_not_configured":
      return { key: "draftLlmOff" };
    case "no_default_source":
      return { key: "noDefaultSource" };
    case "draft_rejected":
      return { key: "noPriceFound", detail: detail.replace(/^no_options:?\s*/, "") };
    case "pricing_version_reused":
      return { key: "versionReused" };
    case "execution_profile_priced":
    case "draft_profile_mismatch":
      return { key: "profilePriced" };
    case "INVALID_JSON":
    case "INVALID_REQUEST":
    case "REQUEST_BODY_TOO_LARGE":
    case "invalid_json":
    case "invalid_model_id":
    case "invalid_draft":
    case "credit_override_unknown_option":
      return { key: "invalidInput" };
    case "fetch_failed":
    case "page_too_large":
      return { key: "fetchFailed" };
    case "no_draft":
      return { key: "noDraft" };
    case "API_RATE_LIMITED":
      return { key: "rateLimited" };
    case "forbidden":
      return { key: "forbidden" };
    case "timeout":
      return { key: "timeout" };
    case "network_error":
      return { key: "network" };
    case "session_expired":
      return { key: "sessionExpired" };
    default:
      return { key: "unknown", code };
  }
};

/**
 * The admin session check's own 404 ("Not found."), as opposed to a
 * catalogue refusal that is also a 404 (no_draft when another admin applied
 * the draft first), which must not send the operator to sign in again.
 */
export const isSessionGone = (status: number, payload: { error?: string } | null) =>
  status === 404 && (payload === null || payload.error === "Not found.");

/** The refusal a response carries, with the reasons that explain it best. */
export const refusalReasons = (error: string, reasons: readonly string[]): string[] =>
  error === "not_admitted" && reasons.length > 0 ? [...reasons] : [error];

export const optionKey = (option: { quality: string; size: string }) => `${option.quality}|${option.size}`;

/**
 * Credits the operator typed, checked against each option's floor. An option
 * whose floor the server could not compute (unbounded worst case) is not an
 * input error: the draft's own reasons already say why it cannot apply.
 */
export const creditProblems = (
  prices: readonly ImageOptionPrice[],
  edits: Readonly<Record<string, string>>,
  floors: readonly ImageOptionFloor[]
): Record<string, "not_a_number" | "below_floor"> => {
  const floorByKey = new Map(floors.map((floor) => [optionKey(floor), floor.floor]));
  const problems: Record<string, "not_a_number" | "below_floor"> = {};
  for (const price of prices) {
    const key = optionKey(price);
    const typed = edits[key];
    const credits = typed === undefined ? price.credits : Number(typed);
    if (!Number.isInteger(credits) || credits <= 0 || credits > 10_000) {
      problems[key] = "not_a_number";
      continue;
    }
    const floor = floorByKey.get(key);
    if (floor !== null && floor !== undefined && credits < floor) problems[key] = "below_floor";
  }
  return problems;
};

/** The apply request's credit overrides: only options whose credits changed. */
export const creditOverrides = (prices: readonly ImageOptionPrice[], edits: Readonly<Record<string, string>>) =>
  prices.flatMap((price) => {
    const typed = edits[optionKey(price)];
    if (typed === undefined || Number(typed) === price.credits) return [];
    return [{ quality: price.quality, size: price.size, credits: Number(typed) }];
  });

export const priceRange = (prices: readonly { credits: number }[]) =>
  prices.length === 0
    ? null
    : { count: prices.length, min: Math.min(...prices.map((p) => p.credits)), max: Math.max(...prices.map((p) => p.credits)) };

export const QUALITY_ORDER = ["low", "medium", "high"] as const;
export const SIZE_ORDER = ["1024x1024", "1536x1024", "1024x1536"] as const;

/** Prices in reading order: quality, then square / landscape / portrait. */
export const orderedPrices = <P extends { quality: string; size: string }>(prices: readonly P[]): P[] =>
  [...prices].sort(
    (a, b) =>
      QUALITY_ORDER.indexOf(a.quality as never) - QUALITY_ORDER.indexOf(b.quality as never) ||
      SIZE_ORDER.indexOf(a.size as never) - SIZE_ORDER.indexOf(b.size as never)
  );

export const formatUsd = (microUsd: number) => `$${(microUsd / 1_000_000).toFixed(3)}`;

/** Server rows (served models + unresolved runtime rows) as one list. */
export const imageCatalogItems = (report: {
  models: Array<{
    id: string;
    name: string;
    provider: string;
    apiModelId?: string;
    sizes?: string[];
    qualities?: string[];
    source: "code" | "catalog";
    enabled: boolean | null;
    holdReason: string | null;
    disabledReason: string | null;
    pricingVersion: string;
    prices?: ImageOptionPrice[];
    floors?: ImageOptionFloor[];
    priceVerification?: { verifiedAt: string | null; sources: string[]; thinkingCapMicroUsd: number | null };
    admissionIfEnabled: Admission;
    draft: unknown;
    draftCreatedAt?: string | null;
    draftReview?: ImageDraftReview | null;
  }>;
  pending?: Array<{
    modelId: string;
    profile: unknown;
    draft: unknown;
    draftCreatedAt?: string | null;
    draftReview?: ImageDraftReview | null;
    problem: string | null;
  }>;
}): ImageCatalogItem[] => {
  const served = report.models.map(
    (row): ImageCatalogItem => ({
      id: row.id,
      name: row.name,
      provider: row.provider,
      apiModelId: row.apiModelId ?? row.id,
      source: row.source,
      sizes: row.sizes ?? [],
      qualities: row.qualities ?? [],
      served: {
        enabled: row.enabled,
        holdReason: row.holdReason,
        disabledReason: row.disabledReason,
        pricingVersion: row.pricingVersion,
        prices: row.prices ?? [],
        floors: row.floors ?? [],
        priceVerification: row.priceVerification ?? { verifiedAt: null, sources: [], thinkingCapMicroUsd: null },
        admissionIfEnabled: row.admissionIfEnabled,
      },
      problem: null,
      draft: (row.draft as ImageDraft | null) ?? null,
      draftCreatedAt: row.draftCreatedAt ?? null,
      draftReview: row.draftReview ?? null,
      raw: row,
    })
  );
  const pending = (report.pending ?? []).map((row): ImageCatalogItem => {
    const profile = (row.profile ?? {}) as Partial<{ provider: string; apiModelId: string; name: string; sizes: string[]; qualities: string[] }>;
    return {
      id: row.modelId,
      name: typeof profile.name === "string" ? profile.name : row.modelId,
      provider: typeof profile.provider === "string" ? profile.provider : "",
      apiModelId: typeof profile.apiModelId === "string" ? profile.apiModelId : row.modelId,
      source: "catalog",
      sizes: Array.isArray(profile.sizes) ? profile.sizes : [],
      qualities: Array.isArray(profile.qualities) ? profile.qualities : [],
      served: null,
      problem: row.problem,
      draft: (row.draft as ImageDraft | null) ?? null,
      draftCreatedAt: row.draftCreatedAt ?? null,
      draftReview: row.draftReview ?? null,
      raw: row,
    };
  });
  return [...pending, ...served];
};
