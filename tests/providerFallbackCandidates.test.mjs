import assert from "node:assert/strict";
import test from "node:test";

import { selectFallbackCandidates } from "../lib/providerFallbackCandidates.ts";

// RECON-OPS-001. The observed defect: `gemini-2-5-flash` was in incident and
// its banner offered "Mistral Small 4, Llama 3.1" -- both of whose providers
// were degraded in the same snapshot -- with no mention of that anywhere.
const catalogue = (statuses) => ({
  isPublicModel: (modelId) => Object.hasOwn(statuses, modelId),
  statusOf: (modelId) => statuses[modelId],
});

test("an operational candidate is offered before a degraded one", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "mistral-small-4",
    recommendedModelIds: ["llama-3-1", "claude-haiku-4-5"],
    ...catalogue({
      "mistral-small-4": "limited",
      "llama-3-1": "limited",
      "claude-haiku-4-5": "available",
    }),
  });

  assert.equal(fallbackModelIds[0], "claude-haiku-4-5");
  assert.deepEqual(fallbackModelIds, [
    "claude-haiku-4-5",
    "mistral-small-4",
    "llama-3-1",
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
    recommendedModelIds: ["llama-3-1"],
    ...catalogue({ "mistral-small-4": "limited", "llama-3-1": "limited" }),
  });

  assert.deepEqual(fallbackModelIds, ["mistral-small-4", "llama-3-1"]);
  assert.equal(fallbackHealth, "degraded");
});

test("no candidate survives -- the caller is told none, never a fabricated list", () => {
  const { fallbackModelIds, fallbackHealth } = selectFallbackCandidates({
    replacementModelId: "mistral-small-4",
    recommendedModelIds: ["llama-3-1"],
    ...catalogue({
      "mistral-small-4": "unavailable",
      "llama-3-1": "unavailable",
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
