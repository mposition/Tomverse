import assert from "node:assert/strict";
import test from "node:test";

import {
  creditOverrides,
  creditProblems,
  imageCatalogItems,
  imageFlowSteps,
  imageNextAction,
  imageStage,
  needsAction,
  orderedPrices,
  priceRange,
  reasonMessage,
  refusalReasons,
} from "../lib/adminModelCatalogFlow.ts";

const draft = {
  pricingVersion: "qwen-image-2.0-2026-11-12-llm",
  prices: [
    { quality: "medium", size: "1024x1024", credits: 41, outputCostMicroUsd: 35_000 },
    { quality: "low", size: "1024x1024", credits: 24, outputCostMicroUsd: 20_000 },
  ],
  verification: { verifiedAt: "2026-11-12", sources: ["https://www.alibabacloud.com/help/en/model-studio/model-pricing"], thinkingCapMicroUsd: 0 },
};
const floors = [
  { quality: "low", size: "1024x1024", floor: 24 },
  { quality: "medium", size: "1024x1024", floor: 41 },
];

const served = (fields = {}) => ({
  id: "gpt-image-2",
  name: "GPT Image 2",
  provider: "openai",
  apiModelId: "gpt-image-2",
  sizes: ["1024x1024"],
  qualities: ["low"],
  source: "code",
  enabled: null,
  holdReason: null,
  disabledReason: null,
  pricingVersion: "v1",
  prices: [],
  floors: [],
  admissionIfEnabled: { admitted: true },
  draft: null,
  ...fields,
});

const itemsOf = (models = [], pending = []) => imageCatalogItems({ models, pending });

test("each model is on one step of the flow, read from what the server reported", () => {
  const [invalid, unpriced, drafted] = itemsOf([], [
    { modelId: "gemini-nano-banana-2.1", profile: { provider: "google" }, draft: null, problem: "invalid_full_profile" },
    { modelId: "qwen-image-2.0", profile: { provider: "qwen", apiModelId: "qwen-image-2.0", name: "Qwen Image 2.0" }, draft: null, problem: "no_price_revision" },
    { modelId: "qwen-image-3", profile: { provider: "qwen", apiModelId: "qwen-image-3" }, draft, problem: "no_price_revision" },
  ]);
  assert.equal(imageStage(invalid), "profile_invalid");
  assert.equal(imageStage(unpriced), "needs_draft");
  assert.equal(unpriced.name, "Qwen Image 2.0");
  assert.equal(imageStage(drafted), "draft_ready");

  const [serving, held, ready, blocked, servingWithDraft, noBudget] = itemsOf([
    served(),
    served({ id: "held", holdReason: "provider slow", disabledReason: "operational_hold" }),
    served({ id: "ready", source: "catalog", disabledReason: "price_unverified", admissionIfEnabled: { admitted: true } }),
    served({ id: "blocked", disabledReason: "price_unverified", admissionIfEnabled: { admitted: false, reasons: ["credits_below_floor:low/1024x1024", "provider_budget_missing"] } }),
    served({ id: "repriced", draft }),
    served({ id: "no-budget", source: "catalog", disabledReason: "price_unverified", admissionIfEnabled: { admitted: false, reasons: ["provider_budget_missing"] } }),
  ]);
  assert.equal(imageStage(serving), "serving");
  assert.equal(imageStage(held), "held");
  assert.equal(imageStage(ready), "ready_to_enable");
  assert.equal(imageStage(blocked), "blocked");
  // Only the budget is missing: a new draft would not help, so it is its own step.
  assert.equal(imageStage(noBudget), "needs_budget");
  assert.equal(imageNextAction("needs_budget"), "none");
  assert.deepEqual(imageFlowSteps("needs_budget").map((step) => step.state), ["done", "done", "done", "attention"]);
  // A new draft for a serving model asks for the price check before anything else.
  assert.equal(imageStage(servingWithDraft), "draft_ready");
  // Waiting for the operator: a model added here until it serves, or any draft.
  // A code model the code keeps off is not a step the operator owes.
  assert.equal(needsAction(unpriced, imageStage(unpriced)), true);
  assert.equal(needsAction(ready, imageStage(ready)), true);
  assert.equal(needsAction(blocked, imageStage(blocked)), false);
  assert.equal(needsAction(serving, imageStage(serving)), false);
  assert.equal(needsAction(held, imageStage(held)), false);
  assert.equal(needsAction(servingWithDraft, imageStage(servingWithDraft)), true);
});

test("the stepper marks done, now and attention, and every stage offers exactly one next action", () => {
  assert.deepEqual(imageFlowSteps("needs_draft").map((step) => step.state), ["done", "current", "todo", "todo"]);
  assert.deepEqual(imageFlowSteps("draft_ready").map((step) => step.state), ["done", "done", "current", "todo"]);
  assert.deepEqual(imageFlowSteps("ready_to_enable").map((step) => step.state), ["done", "done", "done", "current"]);
  assert.deepEqual(imageFlowSteps("profile_invalid").map((step) => step.state), ["attention", "todo", "todo", "todo"]);
  assert.deepEqual(imageFlowSteps("blocked").map((step) => step.state), ["done", "done", "attention", "todo"]);
  assert.equal(imageNextAction("profile_invalid"), "fix_profile");
  assert.equal(imageNextAction("needs_draft"), "make_draft");
  assert.equal(imageNextAction("draft_ready"), "review_prices");
  assert.equal(imageNextAction("ready_to_enable"), "enable");
  assert.equal(imageNextAction("blocked"), "redraft");
});

test("server codes become message keys with their parameters, never shown raw", () => {
  assert.deepEqual(reasonMessage("invalid_full_profile"), { key: "invalidProfile" });
  assert.deepEqual(reasonMessage("no_price_revision"), { key: "noPrice" });
  assert.deepEqual(reasonMessage("credits_below_floor:high/1536x1024"), { key: "creditsBelowFloor", quality: "high", size: "1536x1024" });
  assert.deepEqual(reasonMessage("unofficial_source:https://blog.example.com/prices"), { key: "unofficialSource", host: "blog.example.com" });
  assert.deepEqual(reasonMessage("thinking_cap_below_minimum:12000"), { key: "thinkingCapBelowMinimum", minimum: "12000" });
  assert.deepEqual(reasonMessage("draft_rejected", "no_options: not listed"), { key: "noPriceFound", detail: "not listed" });
  assert.deepEqual(reasonMessage("API_RATE_LIMITED"), { key: "rateLimited" });
  assert.deepEqual(reasonMessage("something_new"), { key: "unknown", code: "something_new" });
  // A refused enable explains itself through the judge's reasons.
  assert.deepEqual(refusalReasons("not_admitted", ["provider_budget_missing"]), ["provider_budget_missing"]);
  assert.deepEqual(refusalReasons("pricing_version_reused", []), ["pricing_version_reused"]);
});

test("typed credits are checked against each floor and only changed options are sent", () => {
  assert.deepEqual(creditProblems(draft.prices, {}, floors), {});
  assert.deepEqual(creditProblems(draft.prices, { "medium|1024x1024": "40" }, floors), { "medium|1024x1024": "below_floor" });
  assert.deepEqual(creditProblems(draft.prices, { "low|1024x1024": "2.5" }, floors), { "low|1024x1024": "not_a_number" });
  assert.deepEqual(creditProblems(draft.prices, { "low|1024x1024": "" }, floors), { "low|1024x1024": "not_a_number" });
  // No floor (unbounded worst case) is not an input error; the draft's reasons say why.
  assert.deepEqual(creditProblems(draft.prices, { "low|1024x1024": "1" }, [{ quality: "low", size: "1024x1024", floor: null }]), {});

  assert.deepEqual(creditOverrides(draft.prices, { "medium|1024x1024": "45", "low|1024x1024": "24" }), [
    { quality: "medium", size: "1024x1024", credits: 45 },
  ]);
  assert.deepEqual(creditOverrides(draft.prices, {}), []);
});

test("prices read in quality then size order, and the summary gives the range", () => {
  assert.deepEqual(
    orderedPrices([
      { quality: "high", size: "1024x1536" },
      { quality: "low", size: "1536x1024" },
      { quality: "low", size: "1024x1024" },
    ]).map((price) => `${price.quality}|${price.size}`),
    ["low|1024x1024", "low|1536x1024", "high|1024x1536"]
  );
  assert.deepEqual(priceRange(draft.prices), { count: 2, min: 24, max: 41 });
  assert.equal(priceRange([]), null);
});
