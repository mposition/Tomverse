"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import dynamic from "next/dynamic";
import {
  ArrowLeft,
  Boxes,
  Brain,
  Check,
  ChevronRight,
  Code2,
  Globe2,
  Image as ImageIcon,
  LockKeyhole,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ModelSelectionBadge } from "@/components/chat/ModelSelectionBadge";
import { useHasCoarsePointer } from "@/components/chat/useHasCoarsePointer";
import { useLanguage } from "@/components/LanguageProvider";
import type { AiModel, ModelTier } from "@/lib/models";
import {
  modelPickerCopy,
  modelPickerFeatureLabels,
  modelPickerStepCopy,
  modelPickerUseCaseLabels,
  type ModelPickerLanguage,
} from "@/lib/modelPickerPresentation";
import {
  getModelRecommendations,
  type ModelRecommendation,
} from "@/lib/modelRecommendations";
import { deriveModelSelectionLimit } from "@/lib/modelSelectionLimit";
import {
  countActiveModelCatalogueFilters,
  EMPTY_MODEL_CATALOGUE_FILTERS,
  type ModelCatalogueFilters,
  type ModelCatalogueStatusRecord,
} from "@/lib/modelCatalogueFilters";

/**
 * The 30+ model rows and the advanced filter sheet are the expensive part of
 * this dialog, and a beginner who picks from the recommendations never sees
 * them. Loading the catalogue on demand keeps opening the picker cheap instead
 * of merely hiding the list with CSS.
 */
const ModelCatalogue = dynamic(
  () => import("@/components/chat/ModelCatalogue").then((module) => module.ModelCatalogue),
  {
    ssr: false,
    loading: () => (
      <div
        data-testid="model-catalogue-loading"
        className="flex min-h-32 flex-1 items-center justify-center px-4 py-8 text-xs text-zinc-400"
      >
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    ),
  }
);

export type ModelPickerAnalyticsEvent =
  | "model_picker_all_opened"
  | "model_picker_search_used"
  | "model_picker_filter_opened"
  | "model_picker_filter_applied"
  | "model_picker_max_reached"
  | "recommended_model_accepted";

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

const FEATURE_ICONS = {
  image: ImageIcon,
  reasoning: Brain,
  search: Globe2,
  code: Code2,
} as const;

export type ModelPickerPanelProps = {
  models: readonly AiModel[];
  selectedModelIds: string[];
  maxSelectableModels: number;
  currentPlan: ModelTier | "Guest";
  isGuestMode: boolean;
  isMobileShell: boolean;
  /** Single-column sheet layout, matching the mobile portal breakpoint. */
  isCompactLayout: boolean;
  modelStatuses: Record<string, ModelCatalogueStatusRecord>;
  hasImageAttachments: boolean;
  favoriteModelIds: string[];
  recentModelIds: string[];
  personalizedModelIds: string[];
  /** Selection minus models disabled for this conversation, for the footer estimate. */
  activeSelectedCount: number;
  selectedBaseCredits: number;
  searchInputRef: RefObject<HTMLInputElement | null>;
  /**
   * The picker shell owns the document-level Escape listener, so it asks the
   * panel first: filter sheet closes before the All-models step, which closes
   * before the dialog itself.
   */
  escapeHandlerRef: MutableRefObject<(() => boolean) | null>;
  onToggleModel: (modelId: string) => boolean;
  onRequestSwap: (model: AiModel) => void;
  onToggleFavorite: (modelId: string) => void;
  onRememberRecentModel: (modelId: string) => void;
  onBackToActions: () => void;
  onDone: () => void;
  onTrackEvent: (
    event: ModelPickerAnalyticsEvent,
    properties?: { model_id?: string; recommendation_rank?: number }
  ) => void;
  comboFinderSlot?: React.ReactNode;
};

export function ModelPickerPanel({
  models,
  selectedModelIds,
  maxSelectableModels,
  currentPlan,
  isGuestMode,
  isMobileShell,
  isCompactLayout,
  modelStatuses,
  hasImageAttachments,
  favoriteModelIds,
  recentModelIds,
  personalizedModelIds,
  activeSelectedCount,
  selectedBaseCredits,
  searchInputRef,
  escapeHandlerRef,
  onToggleModel,
  onRequestSwap,
  onToggleFavorite,
  onRememberRecentModel,
  onBackToActions,
  onDone,
  onTrackEvent,
  comboFinderSlot,
}: ModelPickerPanelProps) {
  const { t, lang } = useLanguage();
  // Layout stays keyed on isMobileShell; touch hit area tracks the input device
  // so a coarse-pointer tablet at >=768px (which uses the desktop layout) still
  // gets 44px targets, while a mouse-only desktop keeps its compact density.
  const hasCoarsePointer = useHasCoarsePointer();
  const touchTarget = isMobileShell || hasCoarsePointer;
  const language = lang as ModelPickerLanguage;
  const pickerCopy = modelPickerCopy[language];
  const stepCopy = modelPickerStepCopy[language];
  const useCaseLabels = modelPickerUseCaseLabels[language];
  const featureLabels = modelPickerFeatureLabels[language];

  const useIdSafe = useId();
  const [step, setStep] = useState<"recommended" | "all">("recommended");
  const [searchQuery, setSearchQuery] = useState("");
  const [filters, setFilters] = useState<ModelCatalogueFilters>(
    EMPTY_MODEL_CATALOGUE_FILTERS
  );
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);
  const hasTrackedSearchRef = useRef(false);
  const openAllButtonRef = useRef<HTMLButtonElement | null>(null);

  const limitDescriptionId = `${useIdSafe}-model-limit`;
  const trimmedQuery = searchQuery.trim();
  // Searching is a shortcut into the catalogue, not a third screen: results
  // always render in the full list so the same filters and rows apply, and
  // clearing the box drops the user back exactly where they were.
  const showCatalogue = step === "all" || trimmedQuery.length > 0;
  const selectionLimit = deriveModelSelectionLimit({
    selectedCount: selectedModelIds.length,
    maxCount: maxSelectableModels,
  });
  const isAtCapacity = selectionLimit.limitReached;
  const activeFilterCount = countActiveModelCatalogueFilters(filters);

  const statusesForRecommendations = useMemo(() => {
    const record: Record<string, "available" | "limited" | "unavailable"> = {};
    for (const [modelId, value] of Object.entries(modelStatuses)) {
      record[modelId] = value.status;
    }
    return record;
  }, [modelStatuses]);

  const recommendations = useMemo(
    () =>
      getModelRecommendations({
        models,
        plan: currentPlan,
        isGuestMode,
        modelStatuses: statusesForRecommendations,
        favoriteModelIds,
        personalizedModelIds,
        recentModelIds,
        selectedModelIds,
        language,
        requiresImageInput: hasImageAttachments,
      }),
    [
      currentPlan,
      favoriteModelIds,
      hasImageAttachments,
      isGuestMode,
      language,
      models,
      personalizedModelIds,
      recentModelIds,
      selectedModelIds,
      statusesForRecommendations,
    ]
  );

  const goBackToRecommended = useCallback(() => {
    setStep("recommended");
    setSearchQuery("");
    requestAnimationFrame(() => openAllButtonRef.current?.focus());
  }, []);

  useEffect(() => {
    escapeHandlerRef.current = () => {
      if (isFilterSheetOpen) {
        setIsFilterSheetOpen(false);
        return true;
      }
      if (showCatalogue) {
        goBackToRecommended();
        return true;
      }
      return false;
    };
    return () => {
      escapeHandlerRef.current = null;
    };
  }, [escapeHandlerRef, goBackToRecommended, isFilterSheetOpen, showCatalogue]);

  const openAllModels = () => {
    setStep("all");
    onTrackEvent("model_picker_all_opened");
  };

  // The advanced filters live inside the catalogue step, so this is the same
  // journey a user would take by hand (All models -> Filters) collapsed into
  // one tap. The collapsed-by-default structure is unchanged: nothing about
  // the filter sheet is expanded until this is pressed.
  const openAllModelsWithFilters = () => {
    setStep("all");
    onTrackEvent("model_picker_all_opened");
    setIsFilterSheetOpen(true);
    onTrackEvent("model_picker_filter_opened");
  };

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    // Only that a search happened is recorded -- never the query itself.
    if (value.trim() && !hasTrackedSearchRef.current) {
      hasTrackedSearchRef.current = true;
      onTrackEvent("model_picker_search_used");
    }
    if (!value.trim()) hasTrackedSearchRef.current = false;
  };

  const handleFilterSheetOpenChange = (open: boolean) => {
    setIsFilterSheetOpen(open);
    if (open) onTrackEvent("model_picker_filter_opened");
  };

  const handleFiltersChange = (next: ModelCatalogueFilters) => {
    setFilters(next);
    if (countActiveModelCatalogueFilters(next) > 0) {
      onTrackEvent("model_picker_filter_applied");
    }
  };

  const selectModel = (model: AiModel, rank?: number) => {
    const isSelected = selectedModelIds.includes(model.id);
    onRememberRecentModel(model.id);
    if (!isSelected && isAtCapacity) {
      onTrackEvent("model_picker_max_reached", { model_id: model.id });
      onRequestSwap(model);
      return;
    }
    if (!isSelected && rank !== undefined) {
      onTrackEvent("recommended_model_accepted", {
        model_id: model.id,
        recommendation_rank: rank,
      });
    }
    onToggleModel(model.id);
  };

  const screenTitle = trimmedQuery
    ? stepCopy.searchResultsTitle
    : showCatalogue
      ? stepCopy.allModelsTitle
      : stepCopy.recommendedTitle;

  const openAllHint = `${interpolate(stepCopy.openAllModelsHint, {
    count: models.length,
  })}${
    activeFilterCount > 0
      ? ` · ${interpolate(stepCopy.activeFilters, { count: activeFilterCount })}`
      : ""
  }`;

  // One element, two densities: the compact sheet pins it above the footer as
  // a single 44px row (see below), the roomier layouts keep the two-line card
  // at the end of the recommendation list. Rendering it once -- never twice --
  // keeps `model-picker-open-all` unambiguous for anything selecting by id.
  const openAllEntry = isCompactLayout ? (
    <button
      ref={openAllButtonRef}
      type="button"
      data-testid="model-picker-open-all"
      onClick={openAllModels}
      // The hint is what the wider layout shows on a second line; keeping it
      // in the accessible name means the compact row loses no information for
      // a screen-reader user, only visual height.
      aria-label={`${stepCopy.openAllModels} · ${openAllHint}`}
      className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-zinc-200 px-3 text-left transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      <Boxes className="h-4 w-4 shrink-0 text-purple-500" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-zinc-900 dark:text-zinc-100">
        {stepCopy.openAllModels}
      </span>
      <span className="shrink-0 text-[11px] font-bold text-zinc-500">
        {models.length}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
    </button>
  ) : (
    <button
      ref={openAllButtonRef}
      type="button"
      data-testid="model-picker-open-all"
      onClick={openAllModels}
      className={`flex w-full items-center gap-3 rounded-xl border border-zinc-200 px-3 text-left transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800 ${touchTarget ? "min-h-14 py-2" : "py-2.5"}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-purple-500/10 text-purple-500">
        <Boxes className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">
          {stepCopy.openAllModels}
        </span>
        <span className="text-xs text-zinc-500">{openAllHint}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/*
        One header for every layout. It used to be duplicated (a desktop-only
        row plus a mobile-only row), which left two "back" controls in the DOM
        with only one of them visible -- a trap for anything selecting by role
        or test id.
      */}
      <div className="mb-2 flex shrink-0 items-center gap-2 px-1 py-1">
        <button
          type="button"
          data-testid="model-picker-back"
          onClick={showCatalogue ? goBackToRecommended : onBackToActions}
          className={`flex shrink-0 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-white ${touchTarget ? "h-11 w-11" : "h-9 w-9"}`}
          aria-label={showCatalogue ? stepCopy.backToRecommended : t("auth.cancel")}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <h2
            data-testid="model-picker-title"
            className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100"
          >
            {screenTitle}
          </h2>
          {/*
            The primary, neutral limit status. Reaching the cap is said here
            once -- not here plus a warning block plus the footer.
          */}
          <span
            data-testid="model-picker-selection-count"
            className="block text-xs text-zinc-500"
          >
            {selectedModelIds.length}/{maxSelectableModels}{" "}
            {selectedModelIds.length === 1
              ? t("chat.modelsSelectedOne")
              : t("chat.modelsSelectedOther")}
          </span>
        </div>
      </div>

      <div className="mb-2 shrink-0 px-1">
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400"
            aria-hidden="true"
          />
          <input
            ref={searchInputRef}
            data-testid="model-search-input"
            value={searchQuery}
            onChange={(event) => handleSearchChange(event.target.value)}
            placeholder={pickerCopy.searchPlaceholder}
            aria-label={pickerCopy.searchPlaceholder}
            className={`w-full rounded-lg border border-zinc-200 bg-zinc-50 pl-9 text-xs text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:focus:border-blue-500 ${trimmedQuery ? "pr-12" : "pr-3"} ${touchTarget ? "h-11" : "h-9"}`}
          />
          {trimmedQuery && (
            <button
              type="button"
              data-testid="model-search-clear"
              onClick={() => {
                handleSearchChange("");
                searchInputRef.current?.focus();
              }}
              aria-label={stepCopy.clearSearch}
              className="absolute right-1 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-400 transition hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {selectedModelIds.length > 0 && (
        <div className="mb-2 shrink-0 px-1">
          <p className="mb-1 px-1 text-[11px] font-bold uppercase tracking-wide text-zinc-400">
            {pickerCopy.selectedModelsLabel}
          </p>
          {/*
            On the compact sheet the wrapped chip list cost three rows (~110px)
            at 320px -- with the sticky footer, that left zero model rows fully
            on screen. It is bounded to one horizontally scrollable row instead.

            The chips there also carry their touch target in the layout box
            (44px-tall chip, 44px remove control) rather than in an invisible
            ::before: a scroll container establishes a clipping box, so a hit
            area that lives outside the element's own bounds would be silently
            cut off by it.
          */}
          <div
            data-testid="model-picker-selected-list"
            className={
              isCompactLayout
                ? "flex max-w-full gap-x-2 overflow-x-auto overscroll-x-contain pb-1"
                : "flex flex-wrap gap-x-4 gap-y-2.5 md:gap-1.5"
            }
          >
            {selectedModelIds.map((modelId) => {
              const model = models.find((item) => item.id === modelId);
              return (
                <span
                  key={modelId}
                  data-testid="selected-model-chip"
                  className={`inline-flex max-w-full items-center gap-1 rounded-full border border-blue-300 bg-zinc-100 pl-2 pr-1 text-[11px] font-bold text-zinc-700 dark:border-blue-800 dark:bg-zinc-800 dark:text-zinc-200 ${
                    isCompactLayout ? "h-11 shrink-0" : "py-1"
                  }`}
                >
                  <Check
                    className="h-3 w-3 shrink-0 text-blue-600 dark:text-blue-400"
                    aria-hidden="true"
                  />
                  <ModelLogo model={model} size="xs" />
                  <span className="max-w-[120px] truncate">{model?.name || modelId}</span>
                  <button
                    type="button"
                    aria-label={t("chat.removeModelFromComparison")}
                    onClick={() => onToggleModel(modelId)}
                    className={
                      isCompactLayout
                        ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-500 transition hover:bg-zinc-300/60 dark:text-zinc-400 dark:hover:bg-zinc-700"
                        : `relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-zinc-500 transition before:absolute before:content-[''] hover:bg-zinc-300/60 dark:text-zinc-400 dark:hover:bg-zinc-700 ${touchTarget ? "before:-inset-3.5" : "before:-inset-2"}`
                    }
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/*
        Hitting the comparison cap is a normal constraint, not an error. It used
        to be a full-width amber warning that pushed the actual model catalogue
        off a 320px screen while repeating what the header already said. The
        header's "3/3" is now the primary status; the explanation stays
        reachable -- announced once on reaching the cap, and referenced by every
        model whose activation would require a swap -- without costing a row.
      */}
      {selectionLimit.limitReached && (
        <p
          id={limitDescriptionId}
          data-testid="model-picker-max-reached"
          role="status"
          className="sr-only"
        >
          {interpolate(stepCopy.maxReached, { max: maxSelectableModels })}
        </p>
      )}

      {showCatalogue ? (
        <ModelCatalogue
          models={models}
          lang={language}
          t={t}
          searchQuery={searchQuery}
          filters={filters}
          onFiltersChange={handleFiltersChange}
          isFilterSheetOpen={isFilterSheetOpen}
          onFilterSheetOpenChange={handleFilterSheetOpenChange}
          selectedModelIds={selectedModelIds}
          currentPlan={currentPlan}
          isGuestMode={isGuestMode}
          isMobileShell={isMobileShell}
          modelStatuses={modelStatuses}
          hasImageAttachments={hasImageAttachments}
          favoriteModelIds={favoriteModelIds}
          recentModelIds={recentModelIds}
          isAtCapacity={isAtCapacity}
          limitDescriptionId={limitDescriptionId}
          onToggleFavorite={onToggleFavorite}
          onSelectModel={(model) => selectModel(model)}
        />
      ) : (
        <div
          data-testid="model-picker-scroll-region"
          className="h-0 min-h-0 flex-1 touch-pan-y space-y-2 overflow-x-hidden overflow-y-scroll overscroll-y-contain px-1 pb-4 pr-2 [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch]"
        >
          <p className="px-1 text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
            {stepCopy.recommendedSubtitle}
          </p>

          {recommendations.length === 0 ? (
            <p
              data-testid="model-recommendations-empty"
              className="rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400"
            >
              {stepCopy.recommendedEmpty}
            </p>
          ) : (
            <section
              data-testid="model-recommendations"
              aria-label={stepCopy.recommendedTitle}
              className={`grid gap-2 ${isCompactLayout ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}
            >
              {recommendations.map((recommendation, index) => (
                <RecommendationCard
                  key={recommendation.modelId}
                  recommendation={recommendation}
                  rank={index + 1}
                  model={models.find((item) => item.id === recommendation.modelId)}
                  reasonLabel={useCaseLabels[recommendation.source]}
                  featureLabels={featureLabels}
                  lockLabel={
                    recommendation.lock === "sign_in"
                      ? stepCopy.signInToUse
                      : recommendation.lock === "upgrade"
                        ? stepCopy.upgradeToUse
                        : null
                  }
                  creditsLabel={
                    language === "ko"
                      ? `기본 ${recommendation.credits}크레딧 차감`
                      : `Base cost ${recommendation.credits} credits`
                  }
                  limitedLabel={t("modelStatusReasons.limited")}
                  limitDescriptionId={
                    isAtCapacity && !recommendation.isSelected
                      ? limitDescriptionId
                      : undefined
                  }
                  onSelect={(model) => selectModel(model, index + 1)}
                />
              ))}
            </section>
          )}

          {isCompactLayout ? null : openAllEntry}

          {comboFinderSlot}
        </div>
      )}

      {/*
        On the compact sheet these two entry points used to sit at the bottom
        of the scrolling recommendation list: at 390x844 "All models" started
        182px below the fold, so a phone user had to scroll past every
        recommendation to discover that the other 30+ models -- and the
        advanced filters behind them -- existed at all. Pinned here they cost
        one recommendation card of list height and are on the first screen,
        while the reading order stays recommendations-first and the Done
        control below stays exactly where it was.
      */}
      {isCompactLayout && !showCatalogue && (
        <div className="mt-2 flex shrink-0 items-center gap-2 px-1">
          {openAllEntry}
          <button
            type="button"
            data-testid="model-picker-open-filters"
            onClick={openAllModelsWithFilters}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-xl border border-zinc-200 px-3 text-[11px] font-bold text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            {activeFilterCount > 0
              ? interpolate(stepCopy.activeFilters, { count: activeFilterCount })
              : stepCopy.openFilters}
          </button>
        </div>
      )}

      <div
        data-testid="model-selection-summary"
        className="mt-2 flex shrink-0 items-center gap-2 border-t border-zinc-200 px-1 pt-2 dark:border-zinc-700"
      >
        <p className="min-w-0 flex-1 text-[11px] font-bold text-zinc-600 dark:text-zinc-300">
          {activeSelectedCount}{" "}
          {activeSelectedCount === 1
            ? t("chat.modelsSelectedOne")
            : t("chat.modelsSelectedOther")}{" "}
          · {pickerCopy.baseEstimate}{" "}
          <CreditCostBadge
            credits={selectedBaseCredits}
            size="xs"
            label={
              language === "ko"
                ? `기본 예상 ${selectedBaseCredits}크레딧`
                : `Base estimate ${selectedBaseCredits} credits`
            }
          />
        </p>
        <button
          type="button"
          data-testid="model-picker-done"
          onClick={onDone}
          className={`flex shrink-0 items-center justify-center rounded-xl bg-blue-600 px-3 text-xs font-bold text-white transition hover:bg-blue-500 ${touchTarget ? "h-11" : "py-2"}`}
        >
          {pickerCopy.done}
        </button>
      </div>
    </div>
  );
}

function RecommendationCard({
  recommendation,
  rank,
  model,
  reasonLabel,
  featureLabels,
  lockLabel,
  creditsLabel,
  limitedLabel,
  limitDescriptionId,
  onSelect,
}: {
  recommendation: ModelRecommendation;
  rank: number;
  model: AiModel | undefined;
  reasonLabel: string;
  featureLabels: Record<"image" | "reasoning" | "search" | "code", string>;
  lockLabel: string | null;
  creditsLabel: string;
  limitedLabel: string;
  limitDescriptionId?: string;
  onSelect: (model: AiModel) => void;
}) {
  if (!model) return null;

  return (
    <button
      type="button"
      data-testid="recommended-model-option"
      data-model-id={model.id}
      data-model-plan-locked={recommendation.lock !== "none"}
      data-recommendation-rank={rank}
      data-recommendation-source={recommendation.source}
      aria-pressed={recommendation.isSelected}
      aria-describedby={limitDescriptionId}
      onClick={() => onSelect(model)}
      className={`flex min-h-16 w-full items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition ${
        recommendation.isSelected
          ? "border-blue-300 bg-blue-50/70 dark:border-blue-900/60 dark:bg-blue-950/20"
          : "border-zinc-200 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
      }`}
    >
      <ModelLogo model={model} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-zinc-900 dark:text-zinc-100">
          {model.name}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-zinc-600 dark:text-zinc-300">
          {reasonLabel}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {recommendation.features.map((feature) => {
            const Icon = FEATURE_ICONS[feature];
            return (
              <span
                key={feature}
                className="inline-flex items-center gap-1 text-[11px] font-bold text-zinc-500 dark:text-zinc-400"
              >
                <Icon className="h-3 w-3" aria-hidden="true" />
                {featureLabels[feature]}
              </span>
            );
          })}
          {recommendation.status === "limited" && (
            <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-600 dark:text-amber-400">
              <span
                className="h-1.5 w-1.5 rounded-full bg-amber-500"
                aria-hidden="true"
              />
              {limitedLabel}
            </span>
          )}
        </span>
        {lockLabel && (
          <span className="mt-1 flex items-center gap-1 text-[11px] font-bold text-blue-600 dark:text-blue-300">
            <LockKeyhole className="h-3 w-3" aria-hidden="true" />
            {lockLabel}
          </span>
        )}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-2">
        <CreditCostBadge
          credits={recommendation.credits}
          size="xs"
          testId="recommended-model-credit-badge"
          label={creditsLabel}
        />
        <ModelSelectionBadge
          isSelected={recommendation.isSelected}
          isLocked={recommendation.lock !== "none"}
        />
      </span>
    </button>
  );
}
