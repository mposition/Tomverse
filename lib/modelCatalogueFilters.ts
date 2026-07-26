import type { ModelPickerCapability, ModelPickerUsageBand } from "./modelPickerPresentation.ts";
import type { ModelRecommendationUseCase } from "./modelRecommendations.ts";

/**
 * Filter state for the picker's "All models" step. It lives here rather than
 * beside the list component so the picker shell can own and persist it (and
 * show the active-filter count) without statically importing the heavy
 * catalogue module, which is loaded on demand.
 */

export type ModelCatalogueSort = "recommended" | "credits" | "name";

export type ModelCatalogueFilters = {
  /** The one filter surfaced directly above the list; the rest live in the sheet. */
  task: "all" | ModelRecommendationUseCase;
  provider: string;
  usageBand: ModelPickerUsageBand;
  capability: ModelPickerCapability;
  favoritesOnly: boolean;
  imageInputOnly: boolean;
  availableOnPlanOnly: boolean;
  sort: ModelCatalogueSort;
};

export type ModelCatalogueStatusRecord = {
  status: "available" | "limited" | "unavailable";
  fallbackModelIds: string[];
};

export const EMPTY_MODEL_CATALOGUE_FILTERS: ModelCatalogueFilters = {
  task: "all",
  provider: "all",
  usageBand: "all",
  capability: "all",
  favoritesOnly: false,
  imageInputOnly: false,
  availableOnPlanOnly: false,
  sort: "recommended",
};

/**
 * Counts only filters that actually narrow the list, so the "Filters 2" badge
 * matches what the user would have to undo. Sort is an ordering, not a filter,
 * so it is deliberately excluded.
 */
export const countActiveModelCatalogueFilters = (
  filters: ModelCatalogueFilters
) =>
  Number(filters.task !== "all") +
  Number(filters.provider !== "all") +
  Number(filters.usageBand !== "all") +
  Number(filters.capability !== "all") +
  Number(filters.favoritesOnly) +
  Number(filters.imageInputOnly) +
  Number(filters.availableOnPlanOnly);

/** Clears every filter while leaving the user's chosen ordering in place. */
export const resetModelCatalogueFilters = (
  filters: ModelCatalogueFilters
): ModelCatalogueFilters => ({
  ...EMPTY_MODEL_CATALOGUE_FILTERS,
  sort: filters.sort,
});
