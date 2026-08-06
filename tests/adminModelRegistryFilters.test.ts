import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_LIFECYCLE_FILTER,
  MODEL_LIFECYCLE_FILTERS,
  countModelsInLifecycleView,
  filterRegistryModels,
  lifecycleHiddenNote,
  matchesModelLifecycleFilter,
  modelLifecycleState,
  normalizeModelLifecycleFilter,
  registryEmptyStateMessage,
  registryResultSummary,
  type FilterableRegistryModel,
} from "../lib/adminModelRegistryFilters";
import { isPreLaunchModel, isRetiredModel } from "../lib/models";

// The Admin Console's model registry list opens on the models that can serve a
// request. Everything else stays one explicit selection away -- these pin that
// the classification is exclusive, that it defers to the canonical lifecycle
// predicates rather than re-deriving them, and that hiding a row from the list
// never means hiding it from the operator.

const registryModel = (
  overrides: Partial<FilterableRegistryModel>
): FilterableRegistryModel => ({
  id: "test-model",
  name: "Test Model",
  apiModel: "test-model",
  provider: "openai",
  bestFor: "testing",
  enabled: true,
  status: "enabled",
  ...overrides,
});

const ENABLED = registryModel({ id: "enabled-model", name: "Enabled Model" });

const LIMITED = registryModel({
  id: "limited-model",
  name: "Limited Model",
  status: "limited",
});

/** Operator pulled it for now but it is still listed: not retired. */
const TEMPORARILY_DISABLED = registryModel({
  id: "temporarily-disabled-model",
  name: "Temporarily Disabled Model",
  enabled: false,
  status: "disabled",
  publiclyListed: true,
});

const RETIRED = registryModel({
  id: "retired-model",
  name: "Retired Model",
  enabled: false,
  publiclyListed: false,
  status: "disabled",
});

const PRE_LAUNCH = registryModel({
  id: "pre-launch-model",
  name: "Pre-launch Model",
  enabled: false,
  publiclyListed: false,
  status: "coming-soon",
});

const ARCHIVED_ACTIVE = registryModel({
  id: "archived-active-model",
  name: "Archived Active Model",
  catalogDeleted: true,
});

const ARCHIVED_RETIRED = registryModel({
  id: "archived-retired-model",
  name: "Archived Retired Model",
  enabled: false,
  publiclyListed: false,
  status: "disabled",
  catalogDeleted: true,
});

/** `enabled` and `status` disagree -- the row an operator needs to find. */
const INCONSISTENT = registryModel({
  id: "inconsistent-model",
  name: "Inconsistent Model",
  enabled: true,
  status: "disabled",
});

/** Runs, but is deliberately not offered in the public picker. */
const UNLISTED_BUT_RUNNABLE = registryModel({
  id: "internal-model",
  name: "Internal Model",
  publiclyListed: false,
  status: "enabled",
  enabled: true,
});

const ALL_MODELS = [
  ENABLED,
  LIMITED,
  TEMPORARILY_DISABLED,
  RETIRED,
  PRE_LAUNCH,
  ARCHIVED_ACTIVE,
  ARCHIVED_RETIRED,
  INCONSISTENT,
  UNLISTED_BUT_RUNNABLE,
];

const idsFor = (filter: (typeof MODEL_LIFECYCLE_FILTERS)[number]) =>
  filterRegistryModels(ALL_MODELS, {
    lifecycle: filter,
    provider: "all",
    query: "",
  }).map((model) => model.id);

// --- classification --------------------------------------------------------

test("an enabled model with status enabled classifies as active", () => {
  assert.equal(modelLifecycleState(ENABLED), "active");
});

test("an enabled model with status limited classifies as limited", () => {
  assert.equal(modelLifecycleState(LIMITED), "limited");
});

test("a temporarily disabled but still listed model is disabled, not retired", () => {
  assert.equal(isRetiredModel(TEMPORARILY_DISABLED), false);
  assert.equal(modelLifecycleState(TEMPORARILY_DISABLED), "disabled");
});

test("a retired model classifies as retired, on the canonical predicate", () => {
  assert.equal(isRetiredModel(RETIRED), true);
  assert.equal(modelLifecycleState(RETIRED), "retired");
});

test("a pre-launch model classifies as coming-soon, not retired", () => {
  assert.equal(isPreLaunchModel(PRE_LAUNCH), true);
  assert.equal(modelLifecycleState(PRE_LAUNCH), "coming-soon");
});

test("an archived row is archived even though it is otherwise runnable", () => {
  assert.equal(modelLifecycleState(ARCHIVED_ACTIVE), "archived");
});

test("an archived retired row is archived, not retired", () => {
  // catalogDeleted is a separate, human-controlled admin action. Folding it
  // into retirement would make "Remove from catalogue" indistinguishable from
  // a catalogue retirement decision.
  assert.equal(isRetiredModel(ARCHIVED_RETIRED), true);
  assert.equal(modelLifecycleState(ARCHIVED_RETIRED), "archived");
});

test("a row whose enabled flag and status disagree falls to disabled", () => {
  assert.equal(modelLifecycleState(INCONSISTENT), "disabled");
});

test("classification is exclusive: every model lands in exactly one state", () => {
  for (const model of ALL_MODELS) {
    const states = MODEL_LIFECYCLE_FILTERS.filter(
      (filter) =>
        filter !== "all" &&
        filter !== "operational" &&
        matchesModelLifecycleFilter(model, filter)
    );
    assert.deepEqual(states, [modelLifecycleState(model)]);
  }
});

// --- views -----------------------------------------------------------------

test("operational is the aggregate of active and limited", () => {
  assert.deepEqual(idsFor("operational"), [
    ENABLED.id,
    LIMITED.id,
    UNLISTED_BUT_RUNNABLE.id,
  ]);
});

test("operational judges runnability, not public visibility", () => {
  // An internal model that is deliberately unlisted still serves requests, so
  // it belongs in the operator's default view.
  assert.equal(matchesModelLifecycleFilter(UNLISTED_BUT_RUNNABLE, "operational"), true);
});

test("the default view excludes retired, disabled, coming-soon and archived rows", () => {
  const shown = idsFor(DEFAULT_MODEL_LIFECYCLE_FILTER);
  for (const model of [
    RETIRED,
    TEMPORARILY_DISABLED,
    PRE_LAUNCH,
    ARCHIVED_ACTIVE,
    ARCHIVED_RETIRED,
    INCONSISTENT,
  ]) {
    assert.equal(shown.includes(model.id), false, `${model.id} should be hidden`);
  }
});

test("each single-state view returns only its own rows", () => {
  assert.deepEqual(idsFor("active"), [ENABLED.id, UNLISTED_BUT_RUNNABLE.id]);
  assert.deepEqual(idsFor("limited"), [LIMITED.id]);
  assert.deepEqual(idsFor("coming-soon"), [PRE_LAUNCH.id]);
  assert.deepEqual(idsFor("disabled"), [TEMPORARILY_DISABLED.id, INCONSISTENT.id]);
  assert.deepEqual(idsFor("retired"), [RETIRED.id]);
  assert.deepEqual(idsFor("archived"), [ARCHIVED_ACTIVE.id, ARCHIVED_RETIRED.id]);
});

test("all models applies no lifecycle restriction and preserves input order", () => {
  assert.deepEqual(idsFor("all"), ALL_MODELS.map((model) => model.id));
});

// --- normalisation ---------------------------------------------------------

test("an unknown, empty or missing lifecycle value falls back to operational", () => {
  for (const value of ["retried", "", "ALL", null, undefined, 7, {}]) {
    assert.equal(
      normalizeModelLifecycleFilter(value),
      DEFAULT_MODEL_LIFECYCLE_FILTER
    );
  }
});

test("every known lifecycle value survives normalisation", () => {
  for (const filter of MODEL_LIFECYCLE_FILTERS) {
    assert.equal(normalizeModelLifecycleFilter(filter), filter);
  }
});

// --- combination with the existing filters ---------------------------------

test("lifecycle, provider and query combine as AND", () => {
  const anthropicRetired = registryModel({
    id: "anthropic-retired",
    name: "Anthropic Retired",
    provider: "anthropic",
    enabled: false,
    publiclyListed: false,
    status: "disabled",
  });
  const openaiRetired = registryModel({
    id: "openai-retired",
    name: "OpenAI Retired",
    enabled: false,
    publiclyListed: false,
    status: "disabled",
  });
  const anthropicActive = registryModel({
    id: "anthropic-active",
    name: "Anthropic Active",
    provider: "anthropic",
  });
  const models = [anthropicRetired, openaiRetired, anthropicActive];

  assert.deepEqual(
    filterRegistryModels(models, {
      lifecycle: "retired",
      provider: "anthropic",
      query: "",
    }).map((model) => model.id),
    [anthropicRetired.id]
  );
  // The provider narrows a lifecycle view rather than escaping it.
  assert.deepEqual(
    filterRegistryModels(models, {
      lifecycle: "retired",
      provider: "anthropic",
      query: "active",
    }),
    []
  );
  // ...and the query narrows it further without reaching outside it.
  assert.deepEqual(
    filterRegistryModels(models, {
      lifecycle: "operational",
      provider: "anthropic",
      query: "anthropic",
    }).map((model) => model.id),
    [anthropicActive.id]
  );
});

test("the query still matches id, API id, provider and purpose", () => {
  const model = registryModel({
    id: "gpt-5-6-luna",
    name: "Luna",
    apiModel: "gpt-5.6-luna",
    bestFor: "everyday chat",
  });
  for (const query of ["gpt-5-6", "gpt-5.6", "luna", "OPENAI", " everyday "]) {
    assert.deepEqual(
      filterRegistryModels([model], {
        lifecycle: "operational",
        provider: "all",
        query,
      }).map((entry) => entry.id),
      [model.id],
      `query "${query}" should match`
    );
  }
});

// --- disclosure ------------------------------------------------------------

test("the lifecycle view count ignores the provider and query filters", () => {
  assert.equal(countModelsInLifecycleView(ALL_MODELS, "operational"), 3);
  assert.equal(countModelsInLifecycleView(ALL_MODELS, "all"), ALL_MODELS.length);
});

test("the result summary reports both the shown and the total count", () => {
  assert.equal(registryResultSummary(18, 31), "Showing 18 of 31 models");
  assert.equal(registryResultSummary(1, 1), "Showing 1 of 1 model");
  assert.equal(registryResultSummary(0, 12), "Showing 0 of 12 models");
});

test("the hidden note says how many rows the lifecycle view is holding back", () => {
  assert.equal(
    lifecycleHiddenNote("operational", 6),
    "6 models are outside the Operational view."
  );
  assert.equal(
    lifecycleHiddenNote("retired", 1),
    "1 model is outside the Retired view."
  );
  // Nothing to disclose when nothing is hidden.
  assert.equal(lifecycleHiddenNote("operational", 0), null);
  assert.equal(lifecycleHiddenNote("all", 4), null);
});

test("the empty state names the lifecycle view that produced it", () => {
  assert.equal(
    registryEmptyStateMessage("retired"),
    "No retired models match the current search and provider filters."
  );
  assert.equal(
    registryEmptyStateMessage("coming-soon"),
    "No coming soon models match the current search and provider filters."
  );
  assert.equal(
    registryEmptyStateMessage("all"),
    "No models match the current search and provider filters."
  );
});
