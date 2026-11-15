import {
  canUseModelWithPlan,
  getModel as getStaticModel,
  getModelUsageProfile,
  modelSupportsImageInput,
  resolveSelectableModelId,
  type AiModel,
  type ModelTier,
} from "./models.ts";
import type { WebSearchBackendReadiness } from "@/lib/webSearchBackends";
import {
  getModelPickerFeatures,
  type ModelPickerFeature,
  type ModelPickerLanguage,
} from "./modelPickerPresentation.ts";

/**
 * The picker's first screen shows recommendations only, so this module is the
 * single place that decides which models a beginner is offered before they
 * touch a filter. Every input is passed in explicitly (no module-level user
 * state, no network) so the rules stay deterministic and unit-testable, and so
 * a registry change flows straight through to the recommendations.
 */

export const MODEL_RECOMMENDATION_USE_CASES = [
  "everyday",
  "writing",
  "analysis",
  "multimodal",
  "coding",
  "search",
  "value",
] as const;

export type ModelRecommendationUseCase =
  (typeof MODEL_RECOMMENDATION_USE_CASES)[number];

/** Why a model earned its slot -- shown as a badge, never as a quality rank. */
export type ModelRecommendationSource =
  | ModelRecommendationUseCase
  | "favorite"
  | "personalized"
  | "recent";

export type ModelRecommendationStatus = "available" | "limited";

export type ModelRecommendationLock = "none" | "sign_in" | "upgrade";

export const MAX_MODEL_RECOMMENDATIONS = 8;
/**
 * Target floor, not a quota: when fewer models qualify we show fewer rather
 * than padding the list with models the user cannot actually run.
 */
export const TARGET_MIN_MODEL_RECOMMENDATIONS = 6;
/** Keeps sign-in/upgrade-gated models from crowding out usable ones. */
export const MAX_LOCKED_MODEL_RECOMMENDATIONS = 2;
const MAX_FAVORITE_MODEL_RECOMMENDATIONS = 2;
const MAX_PERSONALIZED_MODEL_RECOMMENDATIONS = 2;
const MAX_RECENT_MODEL_RECOMMENDATIONS = 1;

/**
 * Ordered preference per use case. Position expresses "how well this model
 * fits *this task*", never an absolute ranking of the models against each
 * other -- a model can sit first here and last in another list. Ids must exist
 * in the registry; unknown or retired ids are skipped rather than shown.
 */
const USE_CASE_CANDIDATES: Record<
  ModelRecommendationUseCase,
  readonly string[]
> = {
  everyday: [
    // Swapped on 2026-08-01 when gpt-5-6-luna became DEFAULT_MODEL_ID.
    // gpt-5-4-mini keeps the slot behind it: it is still enabled and still a
    // reasonable everyday pick, so it stays discoverable for the observation
    // period, and this list skips it automatically if it is ever retired.
    // gpt-6-luna took the lead on 2026-10-12, when it became DEFAULT_MODEL_ID,
    // and claude-haiku-5-5 sits ahead of the Haiku it replaced in the guest
    // trio; a disabled id here is skipped, not shown.
    "gpt-6-luna",
    "gpt-5-6-luna",
    "gpt-5-4-mini",
    "gemini-2-5-flash",
    "qwen3.6-flash",
    "claude-haiku-5-5",
    "claude-haiku-4-5",
    "mistral-small-4",
    "glm-5.2",
  ],
  writing: [
    "claude-haiku-5-5",
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "mistral-medium-3-1",
    "qwen3.7-plus",
    "claude-fable-5",
    "gpt-5-6-luna",
  ],
  analysis: [
    "gpt-5-6-sol",
    "gpt-5-6-terra",
    "gpt-5-5",
    "grok-4-5",
    "gemini-3-6-flash",
    "gemini-3-1-pro",
    "claude-sonnet-5",
    "kimi-k3",
    "minimax-m3",
    "mistral-large-3",
  ],
  multimodal: [
    "gemini-3-6-flash",
    "gemini-2-5-flash",
    "gpt-5-6-luna",
    "gemini-3-1-pro",
    "minimax-m3",
    "kimi-k3",
  ],
  coding: [
    "gpt-5-6-terra",
    "deepseek-v4-flash",
    "minimax-m3",
    "kimi-k2.7-code",
    "kimi-k3",
    "deepseek-v4-pro",
  ],
  search: [
    "perplexity/sonar",
    "perplexity/sonar-pro",
    "perplexity/sonar-reasoning-pro",
  ],
  value: [
    // gpt-6-luna replaced gpt-5-6-luna here on 2026-10-12 rather than joining
    // it: a model is recommended once per response, so a second Luna would
    // take the slot the Gemini trio member below needs.
    "gpt-6-luna",
    // The guest trio's Gemini slot moved to gemini-flash-lite-latest on
    // 2026-09-28 (lib/appDefaults.ts). A new guest comparison selects it, so
    // it must be a candidate here or the picker cannot show a selected model.
    // gemini-2-5-flash stays behind it as the fallback.
    "gemini-flash-lite-latest",
    "gemini-2-5-flash",
    "deepseek-v4-flash",
    "mistral-small-4",
    "glm-5.2",
    "qwen3.6-flash",
    "deepseek-v4-pro",
  ],
};

/**
 * The providers a newcomer looks for by name. There are more providers than
 * cards, so these are placed first; the rest follow in catalogue order.
 */
export const FEATURED_PROVIDERS = ["openai", "anthropic", "google", "xai"] as const;

const LISTED_MODEL_IDS: ReadonlySet<string> = new Set(
  MODEL_RECOMMENDATION_USE_CASES.flatMap((useCase) => USE_CASE_CANDIDATES[useCase])
);

const ANALYSIS_USAGE_CLASSES: readonly string[] = ["premium", "reasoning", "premium-reasoning", "frontier", "apex"];

/**
 * Which tasks a model fits by its catalogue profile alone, for a model the
 * tables above do not list. It labels the model's card and backs the task
 * filter; it never decides which models are recommended. Coding has no
 * profile signal and stays table-only.
 */
const profileFitsUseCase = (model: AiModel, useCase: ModelRecommendationUseCase): boolean => {
  const usageClass: string = model.usageClass;
  switch (useCase) {
    case "everyday":
      return usageClass === "standard";
    case "writing":
      return usageClass === "standard" || usageClass === "advanced";
    case "analysis":
      return ANALYSIS_USAGE_CLASSES.includes(usageClass);
    case "multimodal":
      return (usageClass === "standard" || usageClass === "advanced") && modelSupportsImageInput(model);
    case "search":
      return usageClass === "research" || usageClass === "deep-research";
    case "value":
      return getModelUsageProfile(model).credits <= 1;
    case "coding":
      return false;
  }
};

/** The most telling task first, for a card's single reason line. */
const PROFILE_USE_CASE_ORDER: readonly ModelRecommendationUseCase[] = ["search", "analysis", "everyday", "writing", "multimodal", "value"];

export type ModelRecommendationInput = {
  /** Live catalogue (ModelCatalogProvider), so registry edits take effect. */
  models: readonly AiModel[];
  plan: ModelTier | "Guest";
  isGuestMode: boolean;
  /** Per-model operational status from /api/models/status. */
  modelStatuses?: Readonly<Record<string, ModelRecommendationStatus | "unavailable">>;
  favoriteModelIds?: readonly string[];
  /**
   * Model Finder answers the user already gave. Signed-in only -- guests get
   * the stable default set, and analytics consent is never a precondition.
   */
  personalizedModelIds?: readonly string[];
  recentModelIds?: readonly string[];
  selectedModelIds?: readonly string[];
  language?: ModelPickerLanguage;
  /** Image attachments are staged, so text-only models cannot be selected. */
  requiresImageInput?: boolean;
  /**
   * Which application-managed search backends this deployment can reach.
   *
   * Required, because the search badge on a recommendation row is the same
   * claim the composer's chip makes -- that this model answers from the live
   * web -- and a row that carries it on a deployment with no credential is a
   * row that promises a search nothing will run.
   */
  searchBackendReadiness: WebSearchBackendReadiness;
};

export type ModelRecommendation = {
  modelId: string;
  useCase: ModelRecommendationUseCase;
  source: ModelRecommendationSource;
  credits: number;
  features: ModelPickerFeature[];
  status: ModelRecommendationStatus;
  lock: ModelRecommendationLock;
  isSelected: boolean;
};

const getLock = (
  model: AiModel,
  plan: ModelTier | "Guest",
  isGuestMode: boolean
): ModelRecommendationLock => {
  if (canUseModelWithPlan(plan, model)) return "none";
  return isGuestMode ? "sign_in" : "upgrade";
};

/**
 * Preference inside one use-case list: a model the user can run right now
 * beats a gated one, and a healthy provider beats a degraded one, before list
 * position is consulted. Lower is better.
 */
const candidateRank = (
  status: ModelRecommendationStatus,
  lock: ModelRecommendationLock
) => (status === "available" ? 0 : 2) + (lock === "none" ? 0 : 1);

export const getModelRecommendations = ({
  models,
  plan,
  isGuestMode,
  modelStatuses = {},
  favoriteModelIds = [],
  personalizedModelIds = [],
  recentModelIds = [],
  selectedModelIds = [],
  requiresImageInput = false,
  searchBackendReadiness,
}: ModelRecommendationInput): ModelRecommendation[] => {
  const catalogById = new Map(models.map((model) => [model.id, model]));
  const resolveStoredId = (modelId: string) =>
    resolveSelectableModelId(
      modelId,
      (candidateId) => catalogById.get(candidateId) ?? getStaticModel(candidateId)
    ) ??
    modelId;
  const selected = new Set(selectedModelIds.map(resolveStoredId));
  const byId = new Map<string, AiModel>();
  for (const model of models) {
    // A retired or delisted model must never reach the picker, even if a use
    // case still names it.
    if (!model.enabled) continue;
    if (model.catalogDeleted) continue;
    if (model.publiclyListed === false) continue;
    if (modelStatuses[model.id] === "unavailable") continue;
    if (requiresImageInput && !modelSupportsImageInput(model)) continue;
    byId.set(model.id, model);
  }

  const build = (
    modelId: string,
    useCase: ModelRecommendationUseCase,
    source: ModelRecommendationSource
  ): ModelRecommendation | null => {
    const model = byId.get(modelId);
    if (!model) return null;
    const status =
      modelStatuses[model.id] === "limited" || model.status !== "enabled"
        ? "limited"
        : "available";
    return {
      modelId: model.id,
      useCase,
      source,
      credits: getModelUsageProfile(model).credits,
      features: getModelPickerFeatures(model, searchBackendReadiness),
      status,
      lock: getLock(model, plan, isGuestMode),
      isSelected: selected.has(model.id),
    };
  };

  // The card's one-line reason. A listed model keeps its hand-written task; a
  // model the Admin catalogue added is described by its profile.
  const bestUseCaseFor = (modelId: string): ModelRecommendationUseCase => {
    for (const useCase of MODEL_RECOMMENDATION_USE_CASES) {
      if (USE_CASE_CANDIDATES[useCase].includes(modelId)) return useCase;
    }
    const model = byId.get(modelId);
    return (model && PROFILE_USE_CASE_ORDER.find((useCase) => profileFitsUseCase(model, useCase))) ?? "everyday";
  };

  const picks: ModelRecommendation[] = [];
  const usedIds = new Set<string>();
  let lockedCount = 0;

  const take = (recommendation: ModelRecommendation | null) => {
    if (!recommendation) return false;
    if (usedIds.has(recommendation.modelId)) return false;
    if (picks.length >= MAX_MODEL_RECOMMENDATIONS) return false;
    if (
      recommendation.lock !== "none" &&
      lockedCount >= MAX_LOCKED_MODEL_RECOMMENDATIONS
    ) {
      return false;
    }
    picks.push(recommendation);
    usedIds.add(recommendation.modelId);
    if (recommendation.lock !== "none") lockedCount += 1;
    return true;
  };

  // Explicit user signals lead: a favourite is a stronger statement of intent
  // than any use-case heuristic, and the last model they picked is the one
  // they are most likely to want again.
  let favoritesTaken = 0;
  for (const modelId of favoriteModelIds) {
    if (favoritesTaken >= MAX_FAVORITE_MODEL_RECOMMENDATIONS) break;
    const resolvedModelId = resolveStoredId(modelId);
    if (take(build(resolvedModelId, bestUseCaseFor(resolvedModelId), "favorite"))) {
      favoritesTaken += 1;
    }
  }

  let personalizedTaken = 0;
  for (const modelId of personalizedModelIds) {
    if (personalizedTaken >= MAX_PERSONALIZED_MODEL_RECOMMENDATIONS) break;
    const resolvedModelId = resolveStoredId(modelId);
    if (take(build(resolvedModelId, bestUseCaseFor(resolvedModelId), "personalized"))) {
      personalizedTaken += 1;
    }
  }

  let recentsTaken = 0;
  for (const modelId of recentModelIds) {
    if (recentsTaken >= MAX_RECENT_MODEL_RECOMMENDATIONS) break;
    const resolvedModelId = resolveStoredId(modelId);
    if (take(build(resolvedModelId, bestUseCaseFor(resolvedModelId), "recent"))) {
      recentsTaken += 1;
    }
  }

  // One card per provider: its top model. Owner decision 2026-11-15 -- the
  // first screen used to fill seven task slots from tables of model ids, so a
  // model added in the Admin catalogue could never appear (no enabled Gemini
  // or Grok model was listed) while one provider could take two slots.
  //
  // "Top" is the highest-grade model the viewer can run now: a healthy,
  // unlocked model before a degraded or gated one, then the dearer model,
  // which is the provider's more capable one. A model the user already has
  // selected is that provider's card, so the selection stays visible here.
  const shownProviders = new Set(picks.map((pick) => byId.get(pick.modelId)?.provider));
  const providers = [...new Set([...byId.values()].map((model) => model.provider))];
  // Never by selection: selecting a model must not reshuffle the screen.
  const providerOrder = (provider: string) => {
    const featured = (FEATURED_PROVIDERS as readonly string[]).indexOf(provider);
    return featured >= 0 ? featured : FEATURED_PROVIDERS.length;
  };
  const orderedProviders = providers
    .map((provider, index) => ({ provider, index }))
    .sort((left, right) => providerOrder(left.provider) - providerOrder(right.provider) || left.index - right.index);

  for (const { provider } of orderedProviders) {
    if (shownProviders.has(provider)) continue;
    const ranked = [...byId.values()]
      .filter((model) => model.provider === provider && !usedIds.has(model.id))
      .map((model, index) => {
        const useCase = bestUseCaseFor(model.id);
        const built = build(model.id, useCase, useCase);
        return built ? { index, built } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort(
        (left, right) =>
          Number(right.built.isSelected) - Number(left.built.isSelected) ||
          candidateRank(left.built.status, left.built.lock) - candidateRank(right.built.status, right.built.lock) ||
          right.built.credits - left.built.credits ||
          left.index - right.index
      );
    for (const entry of ranked) {
      if (take(entry.built)) {
        shownProviders.add(provider);
        break;
      }
    }
  }

  return picks;
};

/**
 * Backs the "task" filter on the All models screen, so browsing by task uses
 * exactly the same mapping that produced the recommendations.
 */
export const modelMatchesUseCase = (
  modelId: string,
  useCase: ModelRecommendationUseCase,
  /** The catalogue row, so a model no table lists is matched by its profile. */
  model?: AiModel
) =>
  USE_CASE_CANDIDATES[useCase].includes(modelId) ||
  (model !== undefined && !LISTED_MODEL_IDS.has(modelId) && profileFitsUseCase(model, useCase));

/** Every model id referenced by the use-case tables, for registry validation. */
export const getReferencedRecommendationModelIds = () =>
  Array.from(
    new Set(
      MODEL_RECOMMENDATION_USE_CASES.flatMap(
        (useCase) => USE_CASE_CANDIDATES[useCase]
      )
    )
  );

/**
 * True when the recommended screen alone is enough for the user to choose --
 * callers use it to decide whether to nudge them toward "All models".
 */
export const hasSufficientModelRecommendations = (
  recommendations: readonly ModelRecommendation[]
) => recommendations.length >= TARGET_MIN_MODEL_RECOMMENDATIONS;
