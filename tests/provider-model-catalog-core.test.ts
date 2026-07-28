import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_DISABLE_REASON,
  catalogNextCursor,
  isLikelyChatModelId,
  missingConfirmationRuns,
  parseProviderCatalogResponse,
  planCatalogReconciliation,
} from "../lib/providerModelCatalogCore.ts";

test("parses OpenAI-compatible model lists and excludes non-chat products", () => {
  assert.deepEqual(
    parseProviderCatalogResponse("openai", {
      data: [
        { id: "gpt-5.5", owned_by: "openai" },
        { id: "text-embedding-4-large", owned_by: "openai" },
        { id: "whisper-2", owned_by: "openai" },
      ],
    }).map((model) => model.id),
    ["gpt-5.5"]
  );
});

test("treats provider aliases as available model IDs", () => {
  const models = parseProviderCatalogResponse("xai", {
    models: [{ id: "grok-4.5-20260701", aliases: ["grok-4.5"] }],
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5-20260701", "grok-4.5"]
  );
  assert.equal(models[1].metadata.aliasOf, "grok-4.5-20260701");
});

test("uses Gemini base model IDs and only keeps generateContent models", () => {
  const models = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-3.5-flash-001",
        baseModelId: "gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        supportedGenerationMethods: ["generateContent"],
        stage: "STABLE",
      },
      {
        name: "models/gemini-embedding-002",
        supportedGenerationMethods: ["embedContent"],
      },
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "gemini-3.5-flash");
  assert.equal(models[0].displayName, "Gemini 3.5 Flash");
});

test("marks explicit legacy and archived lifecycle states unavailable", () => {
  const google = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-old",
        supportedGenerationMethods: ["generateContent"],
        stage: "LEGACY",
      },
    ],
  });
  const mistral = parseProviderCatalogResponse("mistral", [
    {
      id: "mistral-old",
      archived: true,
      capabilities: { completion_chat: true },
    },
  ]);
  assert.deepEqual(
    [google[0].lifecycle, google[0].available, mistral[0].lifecycle],
    ["legacy", false, "archived"]
  );
});

test("supports provider pagination cursors without accepting arbitrary values", () => {
  assert.equal(catalogNextCursor("google", { nextPageToken: "page-2" }), "page-2");
  assert.equal(
    catalogNextCursor("anthropic", { has_more: true, last_id: "claude-last" }),
    "claude-last"
  );
  assert.equal(
    catalogNextCursor("anthropic", { has_more: false, last_id: "ignored" }),
    null
  );
});

test("requires at least two successful missing scans before likely deprecation", () => {
  assert.equal(missingConfirmationRuns(undefined), 2);
  assert.equal(missingConfirmationRuns("1"), 2);
  assert.equal(missingConfirmationRuns("4"), 4);
  assert.equal(missingConfirmationRuns("99"), 2);
  assert.equal(isLikelyChatModelId("groq", "whisper-large-v3"), false);
  assert.equal(isLikelyChatModelId("groq", "llama-4-scout"), true);
});

// Reconciliation planning. The scenario these are written against is the real
// one: groq's llama-4-scout went missing from successful catalog scans on
// 2026-07-21, reached seven consecutive misses, and stayed enabled and
// user-selectable for six days because nothing consumed that signal.

const groqRegistry = [
  { id: "llama-3-1", apiModel: "llama-3.1-8b-instant", enabled: true, operationalReason: null },
  { id: "llama-3-3", apiModel: "llama-3.3-70b-versatile", enabled: true, operationalReason: null },
  { id: "llama-4-scout", apiModel: "meta-llama/llama-4-scout-17b-16e-instruct", enabled: true, operationalReason: null },
];

const groqCheck = (overrides = {}) => ({
  provider: "groq" as const,
  status: "checked" as const,
  missing: [],
  mapped: [],
  ...overrides,
});

test("plans a disable once a model clears the confirmation threshold", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: [
        {
          modelId: "llama-4-scout",
          apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
          consecutiveMissing: 7,
        },
      ],
      mapped: ["llama-3-1", "llama-3-3"],
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(
    plan.disable.map((item) => item.modelId),
    ["llama-4-scout"]
  );
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.restore, []);
});

test("leaves a model alone until the confirmation threshold is reached", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: [
        {
          modelId: "llama-4-scout",
          apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
          consecutiveMissing: 2,
        },
      ],
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(plan.disable, []);
});

test("acts on nothing when the provider check did not complete", () => {
  for (const status of ["failed", "skipped"] as const) {
    const plan = planCatalogReconciliation({
      check: groqCheck({
        status,
        missing: [
          {
            modelId: "llama-4-scout",
            apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
            consecutiveMissing: 99,
          },
        ],
      }),
      registry: groqRegistry,
      confirmationRuns: 3,
    });
    assert.deepEqual(plan.disable, [], `${status} must not disable anything`);
  }
});

test("refuses to disable a provider's entire enabled lineup in one run", () => {
  // Indistinguishable from a truncated catalog response, and only one of the
  // two readings should take a whole provider offline.
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: groqRegistry.map((row) => ({
        modelId: row.id,
        apiModel: row.apiModel,
        consecutiveMissing: 9,
      })),
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(plan.disable, []);
  assert.equal(plan.hold.length, 1);
  assert.equal(plan.hold[0].reason, "would_disable_every_enabled_model");
  assert.deepEqual(plan.hold[0].modelIds.sort(), ["llama-3-1", "llama-3-3", "llama-4-scout"]);
});

test("restores only what this automation disabled", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({ mapped: ["llama-3-1", "llama-4-scout"] }),
    registry: [
      {
        id: "llama-3-1",
        apiModel: "llama-3.1-8b-instant",
        enabled: false,
        operationalReason: "Disabled by an operator pending a billing review.",
      },
      {
        id: "llama-4-scout",
        apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
        enabled: false,
        operationalReason: `${AUTO_DISABLE_REASON} Missing from 7 consecutive scans.`,
      },
    ],
    confirmationRuns: 3,
  });
  assert.deepEqual(
    plan.restore.map((item) => item.modelId),
    ["llama-4-scout"]
  );
});
