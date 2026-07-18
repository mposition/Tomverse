import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogNextCursor,
  isLikelyChatModelId,
  missingConfirmationRuns,
  parseProviderCatalogResponse,
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
