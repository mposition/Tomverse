import assert from "node:assert/strict";
import test from "node:test";

import {
  PROVIDER_FALLBACKS,
  selectFallbackCandidates,
} from "../lib/providerFallbackCandidates.ts";
import {
  AVAILABLE_MODELS,
  getModel,
  isPubliclySelectableModel,
} from "../lib/models.ts";

// RECON-OPS-001. The observed defect: `gemini-2-5-flash` was in incident and
// its banner offered two models -- both of whose providers
// were degraded in the same snapshot -- with no mention of that anywhere.
const catalogue = (statuses) => ({
  isPublicModel: (modelId) => Object.hasOwn(statuses, modelId),
  statusOf: (modelId) => statuses[modelId],
});

test("an operational candidate is offered before a degraded one", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "mistral-small-4",
    recommendedModelIds: ["qwen3.6-flash", "claude-haiku-4-5"],
    ...catalogue({
      "mistral-small-4": "limited",
      "qwen3.6-flash": "limited",
      "claude-haiku-4-5": "available",
    }),
  });

  assert.equal(fallbackModelIds[0], "claude-haiku-4-5");
  assert.deepEqual(fallbackModelIds, [
    "claude-haiku-4-5",
    "mistral-small-4",
    "qwen3.6-flash",
  ]);
  assert.equal(fallbackHealth, "operational");
});

test("a candidate that is itself unavailable is never recommended", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "gemini-3-1-pro",
    recommendedModelIds: ["claude-haiku-4-5"],
    ...catalogue({
      "gemini-3-1-pro": "unavailable",
      "claude-haiku-4-5": "available",
    }),
  });

  assert.deepEqual(fallbackModelIds, ["claude-haiku-4-5"]);
  assert.equal(fallbackHealth, "operational");
});

test("a degraded-only candidate set is reported as degraded, not as a safe swap", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "mistral-small-4",
    recommendedModelIds: ["qwen3.6-flash"],
    ...catalogue({ "mistral-small-4": "limited", "qwen3.6-flash": "limited" }),
  });

  assert.deepEqual(fallbackModelIds, ["mistral-small-4", "qwen3.6-flash"]);
  assert.equal(fallbackHealth, "degraded");
});

test("no candidate survives -- the caller is told none, never a fabricated list", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "mistral-small-4",
    recommendedModelIds: ["qwen3.6-flash"],
    ...catalogue({
      "mistral-small-4": "unavailable",
      "qwen3.6-flash": "unavailable",
    }),
  });

  assert.deepEqual(fallbackModelIds, []);
  assert.equal(fallbackHealth, "none");
});

test("candidates outside the public catalogue are dropped", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "internal-preview-model",
    recommendedModelIds: ["claude-haiku-4-5"],
    ...catalogue({ "claude-haiku-4-5": "available" }),
  });

  assert.deepEqual(fallbackModelIds, ["claude-haiku-4-5"]);
  assert.equal(fallbackHealth, "operational");
});

test("no replacement configured at all reports none", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: null,
    recommendedModelIds: [],
    ...catalogue({ "claude-haiku-4-5": "available" }),
  });

  assert.deepEqual(fallbackModelIds, []);
  assert.equal(fallbackHealth, "none");
});

test("a duplicated candidate is offered once", () => {
  const { fallbackModelIds } = selectFallbackCandidates({
    replacementModelId: "claude-haiku-4-5",
    recommendedModelIds: ["claude-haiku-4-5", "gpt-5-4-mini"],
    ...catalogue({
      "claude-haiku-4-5": "available",
      "gpt-5-4-mini": "available",
    }),
  });

  assert.deepEqual(fallbackModelIds, ["claude-haiku-4-5", "gpt-5-4-mini"]);
});

// ---------------------------------------------------------------------------
// Entitlement. /api/models/status is public and cached, so its candidate list
// is plan-blind by design; the viewer-side caller narrows it. Consolidating
// xAI on the Pro-only grok-4-5 is what made this matter: without the filter a
// Free user's only offered recovery is a model the swap handler refuses.
// ---------------------------------------------------------------------------

test("a candidate the viewer's plan cannot select is never offered", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "grok-4-5",
    recommendedModelIds: ["gpt-5-4-mini"],
    ...catalogue({ "grok-4-5": "available", "gpt-5-4-mini": "available" }),
    canSelectModel: (modelId) => modelId !== "grok-4-5",
  });

  assert.deepEqual(fallbackModelIds, ["gpt-5-4-mini"]);
  assert.equal(fallbackHealth, "operational");
});

test("no entitled candidate left is reported as none, not as an upgrade pitch", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "grok-4-5",
    recommendedModelIds: [],
    ...catalogue({ "grok-4-5": "available" }),
    canSelectModel: () => false,
  });

  assert.deepEqual(fallbackModelIds, []);
  assert.equal(fallbackHealth, "none");
});

test("omitting the entitlement check keeps every healthy candidate", () => {
  // The public status route has no viewer to check against and must not
  // silently drop candidates because the argument was left off.
  const { fallbackModelIds } = selectFallbackCandidates({
    replacementModelId: "grok-4-5",
    recommendedModelIds: ["gpt-5-4-mini"],
    ...catalogue({ "grok-4-5": "available", "gpt-5-4-mini": "available" }),
  });

  assert.deepEqual(fallbackModelIds, ["grok-4-5", "gpt-5-4-mini"]);
});

test("every provider fallback names live, publicly selectable models from another provider", () => {
  for (const [provider, fallback] of Object.entries(PROVIDER_FALLBACKS)) {
    assert.ok(
      fallback.recommendedModelIds.length > 0,
      `${provider} must offer at least one fallback`
    );
    for (const modelId of fallback.recommendedModelIds) {
      const model = getModel(modelId);
      assert.ok(model, `${provider} recommends unknown model ${modelId}`);
      assert.equal(
        isPubliclySelectableModel(model),
        true,
        `${provider} recommends ${modelId}, which is not publicly selectable`
      );
      assert.notEqual(
        model.provider,
        provider,
        `${provider} recommends ${modelId}, which is served by the failing provider itself`
      );
    }
  }
});

test("every provider in the catalogue has a fallback entry", () => {
  for (const model of AVAILABLE_MODELS) {
    assert.ok(
      PROVIDER_FALLBACKS[model.provider],
      `${model.provider} has no fallback configured`
    );
  }
});
