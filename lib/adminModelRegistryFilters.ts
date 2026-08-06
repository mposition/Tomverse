/**
 * Lifecycle classification and list filtering for the Admin Console's model
 * registry panel.
 *
 * The panel still loads every row -- `GET /api/admin/models` keeps answering
 * from `getRuntimeModels({ includeCatalogDeleted: true })`. Everything here is
 * a *view* decision: which of those rows the list renders. Nothing in this
 * module changes a lifecycle value, deletes a row, or narrows the array the
 * editor, the duplicate action and the replacement-model selector read from.
 *
 * Two rules keep this honest:
 *
 *   * Retirement and pre-launch are not re-derived. `isRetiredModel()` and
 *     `isPreLaunchModel()` in lib/models.ts stay the single definition, so the
 *     console can never disagree with the runtime registry about what
 *     "retired" means -- and a merely disabled model is never mislabelled as
 *     retired.
 *   * `operationalReason` is administrator prose, never a state. It is not
 *     parsed, matched or inspected here.
 *
 * `catalogDeleted` is its own state ("Remove from catalogue", a human admin
 * action) and is deliberately not folded into retirement.
 */

import {
  isPreLaunchModel,
  isRetiredModel,
  type AiModel,
  type AiProvider,
} from "@/lib/models";

/**
 * The mutually exclusive lifecycle states a registry row can be in. Every row
 * lands in exactly one of them; see `modelLifecycleState()` for the order.
 */
export const MODEL_LIFECYCLE_STATES = [
  "active",
  "limited",
  "coming-soon",
  "disabled",
  "retired",
  "archived",
] as const;

export type ModelLifecycleState = (typeof MODEL_LIFECYCLE_STATES)[number];

/**
 * What the list filter can be set to: every state, plus the "operational"
 * aggregate (active + limited) and the unrestricted "all" view.
 */
export const MODEL_LIFECYCLE_FILTERS = [
  "operational",
  ...MODEL_LIFECYCLE_STATES,
  "all",
] as const;

export type ModelLifecycleFilter = (typeof MODEL_LIFECYCLE_FILTERS)[number];

/**
 * The list opens on the models an operator can actually be paged about: the
 * ones a user request can reach right now. Archived, retired, pre-launch and
 * disabled rows stay one explicit selection away, never deleted and never
 * hidden silently -- the result counter always says how many are out of view.
 */
export const DEFAULT_MODEL_LIFECYCLE_FILTER: ModelLifecycleFilter = "operational";

export const MODEL_LIFECYCLE_LABELS: Record<ModelLifecycleFilter, string> = {
  operational: "Operational",
  active: "Active",
  limited: "Limited",
  "coming-soon": "Coming soon",
  disabled: "Disabled",
  retired: "Retired",
  archived: "Archived",
  all: "All models",
};

/** The lifecycle fields a row must carry to be classified. */
export type LifecycleClassifiableModel = Pick<
  AiModel,
  "enabled" | "publiclyListed" | "status" | "catalogDeleted"
>;

/** Everything the registry list filters on: lifecycle, provider, free text. */
export type FilterableRegistryModel = LifecycleClassifiableModel &
  Pick<AiModel, "id" | "name" | "apiModel" | "provider" | "bestFor">;

export type RegistryListFilters = {
  lifecycle: ModelLifecycleFilter;
  provider: "all" | AiProvider;
  query: string;
};

/**
 * Classify a row into exactly one lifecycle state.
 *
 * The order is the contract, not an implementation detail -- the states
 * overlap in the underlying fields, so a row must be claimed by the most
 * specific one first or it would appear under two filters:
 *
 *   1. `catalogDeleted` -> archived. An archived row keeps whatever lifecycle
 *      it was archived in (an archived retired row is archived, not retired),
 *      because "removed from the catalogue" is the fact an operator is looking
 *      for.
 *   2. `isRetiredModel()` -> retired. Delisted + disabled + status disabled.
 *   3. `isPreLaunchModel()` -> coming-soon. The mirror image: not yet, rather
 *      than no longer.
 *   4. runnable + status "limited" -> limited.
 *   5. runnable + status "enabled" -> active.
 *   6. anything else -> disabled. That includes rows whose `enabled` flag and
 *      `status` disagree, which is precisely the inconsistency an operator
 *      needs to find rather than have rounded up into "active".
 */
export const modelLifecycleState = (
  model: LifecycleClassifiableModel
): ModelLifecycleState => {
  if (model.catalogDeleted) return "archived";
  if (isRetiredModel(model)) return "retired";
  if (isPreLaunchModel(model)) return "coming-soon";
  if (model.enabled && model.status === "limited") return "limited";
  if (model.enabled && model.status === "enabled") return "active";
  return "disabled";
};

/**
 * Whether a row belongs in the chosen view. "operational" is the aggregate of
 * active and limited -- the rows that can actually serve a request. It is
 * deliberately not "publicly listed": an internal, unlisted model that still
 * runs is operational, and a delisted-but-running model must not disappear
 * from the operator's default view.
 */
export const matchesModelLifecycleFilter = (
  model: LifecycleClassifiableModel,
  filter: ModelLifecycleFilter
) => {
  if (filter === "all") return true;
  const state = modelLifecycleState(model);
  if (filter === "operational") return state === "active" || state === "limited";
  return state === filter;
};

/**
 * Coerce a URL value into a filter. Anything unknown -- a typo, a stale link,
 * a removed state -- fails safe to the default view rather than erroring or
 * showing an empty list.
 */
export const normalizeModelLifecycleFilter = (
  value: unknown
): ModelLifecycleFilter =>
  typeof value === "string" &&
  (MODEL_LIFECYCLE_FILTERS as readonly string[]).includes(value)
    ? (value as ModelLifecycleFilter)
    : DEFAULT_MODEL_LIFECYCLE_FILTER;

const searchHaystack = (model: FilterableRegistryModel) =>
  [model.id, model.name, model.apiModel, model.provider, model.bestFor]
    .join(" ")
    .toLowerCase();

/**
 * Lifecycle AND provider AND text query, in that order. The order is only
 * about determinism -- the result is the intersection either way -- and the
 * input order is preserved, so the registry's `sortOrder` display order is
 * untouched.
 */
export const filterRegistryModels = <T extends FilterableRegistryModel>(
  models: readonly T[],
  filters: RegistryListFilters
): T[] => {
  const normalizedQuery = filters.query.trim().toLowerCase();
  return models.filter((model) => {
    if (!matchesModelLifecycleFilter(model, filters.lifecycle)) return false;
    if (filters.provider !== "all" && model.provider !== filters.provider) {
      return false;
    }
    if (!normalizedQuery) return true;
    return searchHaystack(model).includes(normalizedQuery);
  });
};

/** How many rows the lifecycle view alone admits, ignoring provider and text. */
export const countModelsInLifecycleView = (
  models: readonly LifecycleClassifiableModel[],
  filter: ModelLifecycleFilter
) =>
  models.reduce(
    (total, model) =>
      matchesModelLifecycleFilter(model, filter) ? total + 1 : total,
    0
  );

export const registryResultSummary = (shown: number, total: number) =>
  `Showing ${shown} of ${total} model${total === 1 ? "" : "s"}`;

/**
 * States plainly that the lifecycle view -- not the search box -- is holding
 * rows back. The default view hides things by design; it must never look like
 * the registry is smaller than it is.
 */
export const lifecycleHiddenNote = (
  filter: ModelLifecycleFilter,
  hiddenCount: number
) =>
  filter === "all" || hiddenCount <= 0
    ? null
    : `${hiddenCount} model${hiddenCount === 1 ? " is" : "s are"} outside the ${MODEL_LIFECYCLE_LABELS[filter]} view.`;

export const registryEmptyStateMessage = (filter: ModelLifecycleFilter) =>
  filter === "all"
    ? "No models match the current search and provider filters."
    : `No ${MODEL_LIFECYCLE_LABELS[filter].toLowerCase()} models match the current search and provider filters.`;
