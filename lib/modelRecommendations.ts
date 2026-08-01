import {
  canUseModelWithPlan,
  getModelUsageProfile,
  modelSupportsImageInput,
  type AiModel,
  type ModelTier,
} from "./models.ts";
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
    "gpt-5-4-mini",
    "gemini-2-5-flash",
    "qwen3.6-flash",
    "claude-haiku-4-5",
    "mistral-small-4",
    "glm-5.2",
  ],
  writing: [
    "claude-haiku-4-5",
    "claude-sonnet-5",
    "mistral-medium-3-1",
    "qwen3.7-plus",
    "claude-fable-5",
    "gpt-5-4-mini",
  ],
  analysis: [
    "claude-sonnet-5",
    "gpt-5-5",
    "grok-4-5",
    "deepseek-r1",
    "gemini-3-1-pro",
    "mistral-large-3",
    "kimi-k3",
  ],
  multimodal: [
    "gemini-3-5-flash",
    "gemini-2-5-flash",
    "gpt-5-4-mini",
    "gemini-3-1-pro",
  ],
  coding: [
    "deepseek-v4-flash",
    "codestral",
    "kimi-k2.7-code",
    "deepseek-v4-pro",
    "deepseek-r1",
  ],
  search: [
    "perplexity/sonar",
    "perplexity/sonar-pro",
    "perplexity/sonar-reasoning-pro",
  ],
  value: [
    "gemini-2-5-flash",
    "deepseek-v4-flash",
    "mistral-small-4",
    "glm-5.2",
    "qwen3.6-flash",
    "deepseek-v4-pro",
  ],
};

/**
 * Models the registry describes as multilingual. On a non-English interface
 * they move to the front of the cost-efficient slot, so the cheapest
 * recommendation is also one that answers well in the user's language.
 */
const MULTILINGUAL_MODEL_IDS = [
  "mistral-small-4",
  "qwen3.6-flash",
  "glm-5.2",
] as const;

const LANGUAGE_SENSITIVE_USE_CASES: readonly ModelRecommendationUseCase[] = [
  "value",
];

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

const orderCandidatesForLanguage = (
  useCase: ModelRecommendationUseCase,
  candidates: readonly string[],
  language: ModelPickerLanguage
) => {
  if (language === "en" || !LANGUAGE_SENSITIVE_USE_CASES.includes(useCase)) {
    return candidates;
  }
  const multilingual = candidates.filter((modelId) =>
    (MULTILINGUAL_MODEL_IDS as readonly string[]).includes(modelId)
  );
  return multilingual.length
    ? [...multilingual, ...candidates.filter((id) => !multilingual.includes(id))]
    : candidates;
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
  language = "en",
  requiresImageInput = false,
}: ModelRecommendationInput): ModelRecommendation[] => {
  const selected = new Set(selectedModelIds);
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
      features: getModelPickerFeatures(model),
      status,
      lock: getLock(model, plan, isGuestMode),
      isSelected: selected.has(model.id),
    };
  };

  const bestUseCaseFor = (modelId: string): ModelRecommendationUseCase => {
    for (const useCase of MODEL_RECOMMENDATION_USE_CASES) {
      if (USE_CASE_CANDIDATES[useCase].includes(modelId)) return useCase;
    }
    return "everyday";
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
    if (take(build(modelId, bestUseCaseFor(modelId), "favorite"))) {
      favoritesTaken += 1;
    }
  }

  let personalizedTaken = 0;
  for (const modelId of personalizedModelIds) {
    if (personalizedTaken >= MAX_PERSONALIZED_MODEL_RECOMMENDATIONS) break;
    if (take(build(modelId, bestUseCaseFor(modelId), "personalized"))) {
      personalizedTaken += 1;
    }
  }

  let recentsTaken = 0;
  for (const modelId of recentModelIds) {
    if (recentsTaken >= MAX_RECENT_MODEL_RECOMMENDATIONS) break;
    if (take(build(modelId, bestUseCaseFor(modelId), "recent"))) {
      recentsTaken += 1;
    }
  }

  for (const useCase of MODEL_RECOMMENDATION_USE_CASES) {
    const candidates = orderCandidatesForLanguage(
      useCase,
      USE_CASE_CANDIDATES[useCase],
      language
    );
    const ranked = candidates
      .map((modelId, index) => ({ modelId, index }))
      .filter(({ modelId }) => byId.has(modelId) && !usedIds.has(modelId))
      .map((entry) => {
        const built = build(entry.modelId, useCase, useCase);
        return built ? { ...entry, built } : null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => {
        const rankDelta =
          candidateRank(left.built.status, left.built.lock) -
          candidateRank(right.built.status, right.built.lock);
        return rankDelta !== 0 ? rankDelta : left.index - right.index;
      });

    for (const entry of ranked) {
      if (take(entry.built)) break;
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
  useCase: ModelRecommendationUseCase
) => USE_CASE_CANDIDATES[useCase].includes(modelId);

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
