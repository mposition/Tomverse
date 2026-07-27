"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  Brain,
  Code2,
  Globe2,
  Image as ImageIcon,
  LockKeyhole,
  SlidersHorizontal,
  Star,
  X,
} from "lucide-react";
import { CreditCostBadge } from "@/components/credits/CreditCostBadge";
import { ModelLogo } from "@/components/chat/ModelLogo";
import { ModelSelectionBadge } from "@/components/chat/ModelSelectionBadge";
import { useHasCoarsePointer } from "@/components/chat/useHasCoarsePointer";
import { getModelUsageProfile } from "@/components/chat/types";
import { getModelExperienceStatus } from "@/lib/modelExperience";
import {
  canUseModelWithPlan,
  modelSupportsImageInput,
  type AiModel,
  type ModelTier,
} from "@/lib/models";
import {
  getModelPickerDescription,
  getModelPickerFeatures,
  getModelPickerUsageBand,
  modelMatchesCapability,
  modelPickerCopy,
  modelPickerFeatureLabels,
  modelPickerStepCopy,
  modelPickerUseCaseLabels,
  type ModelPickerLanguage,
  type ModelPickerUsageBand,
} from "@/lib/modelPickerPresentation";
import {
  MODEL_RECOMMENDATION_USE_CASES,
  modelMatchesUseCase,
} from "@/lib/modelRecommendations";
import {
  countActiveModelCatalogueFilters,
  resetModelCatalogueFilters,
  type ModelCatalogueFilters,
  type ModelCatalogueSort,
  type ModelCatalogueStatusRecord,
} from "@/lib/modelCatalogueFilters";

const PROVIDER_DISPLAY_ORDER = [
  "openai",
  "google",
  "anthropic",
  "deepseek",
  "mistral",
];

const getProviderSortRank = (provider: string) => {
  const priorityIndex = PROVIDER_DISPLAY_ORDER.indexOf(provider);
  return priorityIndex === -1 ? PROVIDER_DISPLAY_ORDER.length : priorityIndex;
};

const interpolate = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce(
    (copy, [key, value]) => copy.replaceAll(`{${key}}`, String(value)),
    template
  );

type ModelCatalogueProps = {
  models: readonly AiModel[];
  lang: ModelPickerLanguage;
  t: (key: string) => string;
  searchQuery: string;
  filters: ModelCatalogueFilters;
  onFiltersChange: (filters: ModelCatalogueFilters) => void;
  isFilterSheetOpen: boolean;
  onFilterSheetOpenChange: (open: boolean) => void;
  selectedModelIds: string[];
  currentPlan: ModelTier | "Guest";
  isGuestMode: boolean;
  isMobileShell: boolean;
  modelStatuses: Record<string, ModelCatalogueStatusRecord>;
  hasImageAttachments: boolean;
  favoriteModelIds: string[];
  recentModelIds: string[];
  onToggleFavorite: (modelId: string) => void;
  onSelectModel: (model: AiModel) => void;
};

export function ModelCatalogue({
  models,
  lang,
  t,
  searchQuery,
  filters,
  onFiltersChange,
  isFilterSheetOpen,
  onFilterSheetOpenChange,
  selectedModelIds,
  currentPlan,
  isGuestMode,
  isMobileShell,
  modelStatuses,
  hasImageAttachments,
  favoriteModelIds,
  recentModelIds,
  onToggleFavorite,
  onSelectModel,
}: ModelCatalogueProps) {
  const pickerCopy = modelPickerCopy[lang];
  const stepCopy = modelPickerStepCopy[lang];
  const useCaseLabels = modelPickerUseCaseLabels[lang];
  const featureLabels = modelPickerFeatureLabels[lang];
  // Touch hit area tracks the input device, not the layout breakpoint, so a
  // coarse-pointer tablet at >=768px still gets 44px targets (see
  // useHasCoarsePointer); isMobileShell continues to drive layout.
  const hasCoarsePointer = useHasCoarsePointer();
  const touchTarget = isMobileShell || hasCoarsePointer;
  const filterSheetRef = useRef<HTMLDivElement | null>(null);
  const filterTriggerRef = useRef<HTMLButtonElement | null>(null);

  const modelProviders = useMemo(
    () =>
      Array.from(new Set(models.map((model) => model.provider))).sort(
        (a, b) => getProviderSortRank(a) - getProviderSortRank(b) || a.localeCompare(b)
      ),
    [models]
  );

  const filteredModels = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return models.filter((model) => {
      const usageProfile = getModelUsageProfile(model);
      const description = getModelPickerDescription(model, lang).toLowerCase();
      const matchesQuery =
        !normalizedQuery ||
        model.name.toLowerCase().includes(normalizedQuery) ||
        model.provider.toLowerCase().includes(normalizedQuery) ||
        description.includes(normalizedQuery);
      const matchesTask =
        filters.task === "all" || modelMatchesUseCase(model.id, filters.task);
      const matchesProvider =
        filters.provider === "all" || model.provider === filters.provider;
      const matchesUsageBand =
        filters.usageBand === "all" ||
        getModelPickerUsageBand(usageProfile.credits) === filters.usageBand;
      const matchesCapability = modelMatchesCapability(model, filters.capability);
      const matchesFavorites =
        !filters.favoritesOnly || favoriteModelIds.includes(model.id);
      const matchesImageInput =
        !filters.imageInputOnly || modelSupportsImageInput(model);
      const matchesCurrentPlan =
        !filters.availableOnPlanOnly || canUseModelWithPlan(currentPlan, model);

      return (
        matchesQuery &&
        matchesTask &&
        matchesProvider &&
        matchesUsageBand &&
        matchesCapability &&
        matchesFavorites &&
        matchesImageInput &&
        matchesCurrentPlan
      );
    });
  }, [
    currentPlan,
    favoriteModelIds,
    filters,
    lang,
    models,
    searchQuery,
  ]);

  const groupedModels = useMemo(() => {
    const favoriteSet = new Set(favoriteModelIds);
    const recentSet = new Set(recentModelIds);

    if (filters.sort !== "recommended") {
      const sorted = [...filteredModels].sort((a, b) =>
        filters.sort === "credits"
          ? getModelUsageProfile(a).credits - getModelUsageProfile(b).credits ||
            a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name)
      );
      return sorted.length ? [{ provider: "", models: sorted }] : [];
    }

    const sortedModels = [...filteredModels].sort((a, b) => {
      const providerDelta =
        getProviderSortRank(a.provider) - getProviderSortRank(b.provider);
      if (providerDelta !== 0) return providerDelta;
      const providerNameDelta = a.provider.localeCompare(b.provider);
      if (providerNameDelta !== 0) return providerNameDelta;
      const favoriteDelta =
        Number(favoriteSet.has(b.id)) - Number(favoriteSet.has(a.id));
      if (favoriteDelta !== 0) return favoriteDelta;
      const recentDelta = Number(recentSet.has(b.id)) - Number(recentSet.has(a.id));
      if (recentDelta !== 0) return recentDelta;
      return a.name.localeCompare(b.name);
    });

    return sortedModels.reduce<Array<{ provider: string; models: AiModel[] }>>(
      (groups, model) => {
        const group = groups.find((item) => item.provider === model.provider);
        if (group) group.models.push(model);
        else groups.push({ provider: model.provider, models: [model] });
        return groups;
      },
      []
    );
  }, [favoriteModelIds, filteredModels, filters.sort, recentModelIds]);

  const activeFilterCount = countActiveModelCatalogueFilters(filters);

  // Escape inside the sheet is handled by the picker shell (it closes the
  // sheet before the dialog); this only has to trap Tab and hand focus back to
  // the trigger the sheet was opened from.
  useEffect(() => {
    if (!isFilterSheetOpen) return;
    const sheet = filterSheetRef.current;
    if (!sheet) return;
    // Captured now so the cleanup returns focus to the trigger that was
    // rendered when the sheet opened, not whatever the ref points at later.
    const trigger = filterTriggerRef.current;

    const focusable = () =>
      Array.from(
        sheet.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null);

    focusable()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !sheet.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    sheet.addEventListener("keydown", handleKeyDown);
    return () => {
      sheet.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [isFilterSheetOpen]);

  const update = <Key extends keyof ModelCatalogueFilters>(
    key: Key,
    value: ModelCatalogueFilters[Key]
  ) => onFiltersChange({ ...filters, [key]: value });

  const taskFilterOptions = ["all", ...MODEL_RECOMMENDATION_USE_CASES] as const;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-1 pb-2">
        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="model-catalogue-task-filter">
            {stepCopy.taskAll}
          </label>
          <select
            id="model-catalogue-task-filter"
            data-testid="model-task-filter"
            value={filters.task}
            onChange={(event) =>
              update("task", event.target.value as ModelCatalogueFilters["task"])
            }
            className={`min-w-0 flex-1 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 ${touchTarget ? "h-11" : "h-9"}`}
          >
            {taskFilterOptions.map((option) => (
              <option key={option} value={option}>
                {option === "all" ? stepCopy.taskAll : useCaseLabels[option]}
              </option>
            ))}
          </select>
          <button
            ref={filterTriggerRef}
            type="button"
            data-testid="model-filter-sheet-trigger"
            aria-expanded={isFilterSheetOpen}
            aria-haspopup="dialog"
            onClick={() => onFilterSheetOpenChange(!isFilterSheetOpen)}
            className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-lg border border-zinc-200 px-3 text-[11px] font-black text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800 ${isMobileShell ? "" : "h-9"}`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
            {activeFilterCount > 0
              ? interpolate(stepCopy.activeFilters, { count: activeFilterCount })
              : stepCopy.openFilters}
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 px-1">
          <p
            data-testid="model-catalogue-result-count"
            className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400"
          >
            {interpolate(stepCopy.resultCount, { count: filteredModels.length })}
          </p>
          {activeFilterCount > 0 && (
            <button
              type="button"
              data-testid="model-filter-reset-all"
              onClick={() =>
                onFiltersChange(resetModelCatalogueFilters(filters))
              }
              className="inline-flex min-h-11 items-center rounded-lg px-2 text-[11px] font-black text-blue-600 underline decoration-dotted underline-offset-2 hover:text-blue-500 dark:text-blue-300"
            >
              {stepCopy.resetAllFilters}
            </button>
          )}
        </div>
      </div>

      <div
        data-testid="model-picker-scroll-region"
        className="h-0 min-h-0 flex-1 touch-pan-y space-y-3 overflow-x-hidden overflow-y-scroll overscroll-y-contain px-1 pb-4 pr-2 [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch] @container/list"
      >
        {groupedModels.map((group) => (
          <div key={group.provider || "all"} className="space-y-1">
            {group.provider && (
              <div className="px-2 text-[10px] font-bold uppercase tracking-wide text-zinc-400">
                {group.provider.toUpperCase()}
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 @[760px]/list:grid-cols-2">
              {group.models.map((model) => {
                const isSelected = selectedModelIds.includes(model.id);
                const isFavorite = favoriteModelIds.includes(model.id);
                const liveStatus = modelStatuses[model.id];
                const modelStatus =
                  liveStatus?.status || getModelExperienceStatus(model);
                const fallbackModels = (liveStatus?.fallbackModelIds || [])
                  .map((id) => models.find((item) => item.id === id))
                  .filter((item): item is AiModel => Boolean(item))
                  .filter((item) => item.enabled && item.id !== model.id)
                  .slice(0, 2);
                const isPlanLocked = !canUseModelWithPlan(currentPlan, model);
                const imageIncompatible =
                  hasImageAttachments && !modelSupportsImageInput(model);
                const selectionDisabled =
                  !model.enabled ||
                  modelStatus === "unavailable" ||
                  imageIncompatible;
                const usageProfile = getModelUsageProfile(model);
                const statusReason = isPlanLocked
                  ? isGuestMode
                    ? t("modelStatusReasons.loginRequired")
                    : t("modelStatusReasons.upgradeRequired")
                  : imageIncompatible
                    ? t("modelStatusReasons.imageUnsupported")
                    : !model.enabled || modelStatus === "unavailable"
                      ? t("modelStatusReasons.unavailable")
                      : model.status !== "enabled" || modelStatus === "limited"
                        ? t("modelStatusReasons.limited")
                        : null;
                const modelDescription = getModelPickerDescription(model, lang);
                const modelFeatures = getModelPickerFeatures(model);

                return (
                  <div
                    key={model.id}
                    className={`flex w-full items-start gap-2 rounded-xl border px-2 py-1.5 transition ${
                      isSelected
                        ? "border-blue-200 bg-blue-50/70 dark:border-blue-900/50 dark:bg-blue-950/20"
                        : "border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    }`}
                  >
                    <button
                      type="button"
                      data-testid="model-favorite-star"
                      onClick={() => onToggleFavorite(model.id)}
                      className={`flex shrink-0 items-center justify-center rounded-lg transition ${touchTarget ? "h-11 w-11" : "h-8 w-8"} ${isFavorite ? "text-amber-400" : "text-zinc-400 hover:text-amber-400"}`}
                      aria-pressed={isFavorite}
                      aria-label={t("chat.favoriteModels")}
                    >
                      <Star className={`h-4 w-4 ${isFavorite ? "fill-current" : ""}`} />
                    </button>
                    <button
                      type="button"
                      data-testid="model-option"
                      data-model-id={model.id}
                      data-model-usage-class={usageProfile.category}
                      data-model-minimum-plan={model.minimumPlan}
                      data-model-image-input={modelSupportsImageInput(model)}
                      data-model-plan-locked={isPlanLocked}
                      disabled={selectionDisabled && !isSelected}
                      onClick={() => onSelectModel(model)}
                      aria-pressed={isSelected}
                      className={`flex min-w-0 flex-1 items-start gap-2 rounded-lg py-0.5 text-sm disabled:cursor-not-allowed disabled:opacity-45 ${touchTarget ? "min-h-11" : ""}`}
                    >
                      <ModelLogo model={model} size="md" />
                      <span className="min-w-0 flex-1 text-left">
                        <span className="flex min-w-0 items-start gap-1.5">
                          <span
                            data-testid="model-option-name"
                            className="min-w-0 whitespace-normal break-words font-semibold leading-5 text-zinc-800 dark:text-zinc-100"
                          >
                            {model.name}
                          </span>
                          <span
                            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                              modelStatus === "available"
                                ? "bg-emerald-500"
                                : modelStatus === "limited"
                                  ? "bg-amber-500"
                                  : "bg-zinc-400"
                            }`}
                            title={
                              modelStatus === "available"
                                ? undefined
                                : statusReason || modelStatus
                            }
                            aria-label={statusReason || modelStatus}
                          />
                        </span>
                        <span className="mt-0.5 block text-[10px] leading-4 text-zinc-500 dark:text-zinc-400">
                          {modelDescription}
                        </span>
                        {statusReason && (
                          <span
                            className={`mt-0.5 flex items-center gap-1 text-[10px] font-bold ${modelStatus === "unavailable" || !model.enabled ? "text-red-500" : modelStatus === "limited" ? "text-amber-500" : "text-blue-500"}`}
                          >
                            {isPlanLocked && (
                              <LockKeyhole className="h-3 w-3" aria-hidden="true" />
                            )}
                            {statusReason}
                          </span>
                        )}
                        {modelFeatures.length > 0 && (
                          <span className="mt-1 flex max-w-full flex-wrap gap-x-2 gap-y-1">
                            {modelFeatures.map((feature) => {
                              const Icon =
                                feature === "image"
                                  ? ImageIcon
                                  : feature === "reasoning"
                                    ? Brain
                                    : feature === "search"
                                      ? Globe2
                                      : Code2;
                              return (
                                <span
                                  key={feature}
                                  className="inline-flex items-center gap-1 text-[9px] font-bold text-zinc-500 dark:text-zinc-300"
                                >
                                  <Icon className="h-3 w-3" aria-hidden="true" />
                                  {featureLabels[feature]}
                                </span>
                              );
                            })}
                          </span>
                        )}
                        {(modelStatus === "limited" ||
                          modelStatus === "unavailable") &&
                          fallbackModels.length > 0 && (
                            <span className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-zinc-500">
                              <span>{t("chat.trySimilarModel")}</span>
                              {fallbackModels.map((fallback) => (
                                <span
                                  key={fallback.id}
                                  className="rounded-full bg-blue-500/10 px-1.5 py-0.5 font-bold text-blue-500"
                                >
                                  {fallback.name}
                                </span>
                              ))}
                            </span>
                          )}
                      </span>
                      <span className="flex shrink-0 flex-col items-end gap-2">
                        <CreditCostBadge
                          credits={usageProfile.credits}
                          testId="model-credit-badge"
                          label={
                            lang === "ko"
                              ? `기본 ${usageProfile.credits}크레딧 차감`
                              : `Base cost ${usageProfile.credits} credits`
                          }
                        />
                        <ModelSelectionBadge
                          isSelected={isSelected}
                          isLocked={isPlanLocked}
                        />
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {filteredModels.length === 0 && filters.favoritesOnly && (
          <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-700">
            <p className="font-bold text-zinc-500 dark:text-zinc-300">
              {t("chat.noFavoriteModelsTitle")}
            </p>
            <p className="mt-1">{t("chat.noFavoriteModelsHint")}</p>
          </div>
        )}
        {filteredModels.length === 0 && !filters.favoritesOnly && (
          <div className="rounded-xl border border-dashed border-zinc-200 px-4 py-8 text-center text-xs text-zinc-400 dark:border-zinc-700">
            {t("chat.noModelsFound")}
          </div>
        )}
      </div>

      {isFilterSheetOpen && (
        <div
          className="absolute inset-0 z-[105] flex items-end justify-center bg-black/40 md:items-center"
          onClick={() => onFilterSheetOpenChange(false)}
        >
          <div
            ref={filterSheetRef}
            role="dialog"
            aria-modal="true"
            aria-label={stepCopy.filterSheetTitle}
            data-testid="model-filter-sheet"
            onClick={(event) => event.stopPropagation()}
            className="max-h-[85%] w-full max-w-md overflow-y-auto rounded-t-3xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-2xl dark:bg-zinc-900 md:rounded-3xl"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <p className="text-sm font-black text-zinc-900 dark:text-zinc-100">
                {stepCopy.filterSheetTitle}
              </p>
              <button
                type="button"
                data-testid="model-filter-sheet-close"
                onClick={() => onFilterSheetOpenChange(false)}
                aria-label={t("auth.cancel")}
                className="flex h-11 w-11 items-center justify-center rounded-xl bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="capability-filter-favorites"
                  aria-pressed={filters.favoritesOnly}
                  onClick={() => update("favoritesOnly", !filters.favoritesOnly)}
                  className={`inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-3 text-[11px] font-black transition ${filters.favoritesOnly ? "border-blue-500 bg-blue-500 text-white" : "border-zinc-200 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                >
                  <Star
                    className={`h-3 w-3 ${filters.favoritesOnly ? "fill-current" : ""}`}
                    aria-hidden="true"
                  />
                  {t("chat.favoriteModels")}
                </button>
                {(
                  [
                    ["fast", pickerCopy.fast],
                    ["reasoning", pickerCopy.deepReasoning],
                    ["search", pickerCopy.webSearch],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    data-testid={`capability-filter-${value}`}
                    aria-pressed={filters.capability === value}
                    onClick={() =>
                      update(
                        "capability",
                        filters.capability === value ? "all" : value
                      )
                    }
                    className={`inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full border px-3 text-[11px] font-black transition ${filters.capability === value ? "border-blue-500 bg-blue-500 text-white" : "border-zinc-200 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                  >
                    {label}
                  </button>
                ))}
                {(
                  [
                    ["imageInputOnly", pickerCopy.imageInputOnly],
                    ["availableOnPlanOnly", pickerCopy.availableOnPlan],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    data-testid={`model-filter-${key}`}
                    aria-pressed={filters[key]}
                    onClick={() => update(key, !filters[key])}
                    className={`inline-flex min-h-11 shrink-0 items-center justify-center rounded-full border px-3 text-[11px] font-black transition ${filters[key] ? "border-blue-500 bg-blue-500 text-white" : "border-zinc-200 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <select
                  value={filters.provider}
                  onChange={(event) => update("provider", event.target.value)}
                  aria-label={pickerCopy.providerAll}
                  className="h-11 w-full min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  <option value="all">{pickerCopy.providerAll}</option>
                  {modelProviders.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
                <select
                  value={filters.usageBand}
                  onChange={(event) =>
                    update("usageBand", event.target.value as ModelPickerUsageBand)
                  }
                  aria-label={pickerCopy.usageAll}
                  className="h-11 w-full min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                >
                  <option value="all">{pickerCopy.usageAll}</option>
                  <option value="light">{pickerCopy.light}</option>
                  <option value="medium">{pickerCopy.medium}</option>
                  <option value="heavy">{pickerCopy.heavy}</option>
                  <option value="intensive">{pickerCopy.intensive}</option>
                </select>
                <select
                  value={filters.sort}
                  onChange={(event) =>
                    update("sort", event.target.value as ModelCatalogueSort)
                  }
                  data-testid="model-sort-select"
                  aria-label={stepCopy.sortLabel}
                  className="h-11 w-full min-w-0 rounded-lg border border-zinc-200 bg-zinc-50 px-2 text-xs font-medium text-zinc-700 outline-none dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200 sm:col-span-2"
                >
                  <option value="recommended">{stepCopy.sortRecommended}</option>
                  <option value="credits">{stepCopy.sortCredits}</option>
                  <option value="name">{stepCopy.sortName}</option>
                </select>
              </div>

              <div className="flex items-center justify-between gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => onFiltersChange(resetModelCatalogueFilters(filters))}
                  className="inline-flex min-h-11 items-center rounded-lg px-2 text-xs font-black text-zinc-600 underline decoration-dotted underline-offset-2 dark:text-zinc-300"
                >
                  {stepCopy.resetAllFilters}
                </button>
                <button
                  type="button"
                  data-testid="model-filter-apply"
                  onClick={() => onFilterSheetOpenChange(false)}
                  className="inline-flex min-h-11 items-center rounded-xl bg-blue-600 px-4 text-xs font-black text-white transition hover:bg-blue-500"
                >
                  {interpolate(stepCopy.resultCount, {
                    count: filteredModels.length,
                  })}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

