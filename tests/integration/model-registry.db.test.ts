import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import {
  ensureModelRegistrySeeded,
  getEnabledRuntimeModel,
  getRuntimeModel,
} from "../../lib/modelRegistry";
import { assertModelRuntimeAvailable } from "../../lib/modelAvailability";
import { getModelBillingProfile, getModelUsageProfile } from "../../lib/models";

const modelId = `integration/model-${randomUUID()}`;

after(async () => {
  await prisma.modelRegistryEntry.deleteMany({ where: { id: modelId } });
  await prisma.$disconnect();
});

// Runs FIRST, before anything in this file calls ensureModelRegistrySeeded():
// the bootstrap memoises itself, so the retirement replay only ever happens on
// the process's first call and this is the one chance to observe it.
//
// The defect it covers: `createMany({ skipDuplicates: true })` only inserts, so
// a model already in the runtime registry when it was retired in lib/models.ts
// kept its old enabled/publiclyListed/status values and stayed on offer. Each
// wave of retirements re-opens that hole for its own ids, so this seeds the
// exact pre-retirement shape and checks the bootstrap closes it.
const RETIRED_MODEL_EXPECTATIONS = [
  { id: "grok-3", replacementModelId: "grok-4-5" },
  { id: "grok-3-mini", replacementModelId: "grok-4-5" },
  { id: "grok-4", replacementModelId: "grok-4-5" },
  { id: "llama-3-1", replacementModelId: "deepseek-v4-flash" },
  { id: "llama-3-3", replacementModelId: "mistral-medium-3-1" },
  { id: "llama-4-scout", replacementModelId: "gemini-3-5-flash" },
] as const;

test("bootstrapping replays catalogue retirements onto pre-existing registry rows", async () => {
  const retiredIds = RETIRED_MODEL_EXPECTATIONS.map((entry) => entry.id);

  // Seed the rows first so they exist, then force them back into the state a
  // pre-retirement deploy would have left them in.
  await prisma.modelRegistryEntry.createMany({
    data: RETIRED_MODEL_EXPECTATIONS.map((entry, index) => ({
      id: entry.id,
      name: `Stale ${entry.id}`,
      apiModel: entry.id,
      provider: entry.id.startsWith("grok") ? "xai" : "groq",
      apiBaseUrl: entry.id.startsWith("grok")
        ? "https://api.x.ai/v1"
        : "https://api.groq.com/openai/v1",
      apiKeyEnvName: entry.id.startsWith("grok") ? "XAI_API_KEY" : "GROQ_API_KEY",
      icon: "?",
      bestFor: "stale row",
      minimumPlan: "Guest",
      usageClass: "standard",
      creditWeight: 1,
      sortOrder: 9_000 + index,
    })),
    skipDuplicates: true,
  });
  await prisma.modelRegistryEntry.updateMany({
    where: { id: { in: [...retiredIds] } },
    data: {
      enabled: true,
      publiclyListed: true,
      status: "enabled",
      replacementModelId: null,
    },
  });

  await ensureModelRegistrySeeded();

  for (const expected of RETIRED_MODEL_EXPECTATIONS) {
    const row = await prisma.modelRegistryEntry.findUnique({
      where: { id: expected.id },
    });
    assert.ok(row, `${expected.id} must never be deleted from the registry`);
    assert.equal(row.enabled, false, `${expected.id} should be disabled`);
    assert.equal(row.publiclyListed, false, `${expected.id} should be delisted`);
    assert.equal(row.status, "disabled");
    assert.equal(row.replacementModelId, expected.replacementModelId);
    // catalogDeleted stays a human-controlled admin action, so the replay
    // must not have set it.
    assert.equal(row.catalogDeleted, false);

    // Historical resolution survives; new calls do not.
    const historical = await getRuntimeModel(expected.id);
    assert.ok(historical, `${expected.id} must stay resolvable for old chats`);
    assert.ok(historical.name);
    assert.equal(await getEnabledRuntimeModel(expected.id), undefined);
    assert.equal(
      (await assertModelRuntimeAvailable(expected.id)).allowed,
      false
    );
  }

  // The replacement each retirement points at has to be something a user can
  // actually pick, or the offer is a dead end.
  for (const expected of RETIRED_MODEL_EXPECTATIONS) {
    const replacement = await getEnabledRuntimeModel(expected.replacementModelId);
    assert.ok(
      replacement,
      `${expected.id} points at ${expected.replacementModelId}, which is not enabled at runtime`
    );
    assert.notEqual(replacement.publiclyListed, false);
  }
});

test("re-running the bootstrap leaves retired rows untouched", async () => {
  const before = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: RETIRED_MODEL_EXPECTATIONS.map((entry) => entry.id) } },
    orderBy: { id: "asc" },
  });

  await ensureModelRegistrySeeded();

  const after = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: RETIRED_MODEL_EXPECTATIONS.map((entry) => entry.id) } },
    orderBy: { id: "asc" },
  });
  assert.equal(after.length, before.length);
  assert.deepEqual(
    after.map((row) => [row.id, row.enabled, row.publiclyListed, row.status]),
    before.map((row) => [row.id, row.enabled, row.publiclyListed, row.status])
  );
});

test("persists and resolves a newly registered model without a source catalogue entry", async () => {
  await ensureModelRegistrySeeded();
  await prisma.modelRegistryEntry.create({
    data: {
      id: modelId,
      name: "Registry Integration Model",
      apiModel: "registry-integration-v1",
      provider: "openai",
      apiBaseUrl: "https://api.openai.com/v1",
      apiKeyEnvName: "OPENAI_API_KEY",
      icon: "T",
      bestFor: "Testing registry persistence",
      minimumPlan: "Free",
      usageClass: "advanced",
      creditWeight: 7,
      publiclyListed: true,
      enabled: true,
      status: "enabled",
      supportsImage: true,
      supportsNativePdf: false,
      contextWindowTokens: 32_000,
      maxOutputTokens: 3_000,
      reservationOutputTokens: 1_200,
      inputUsdPerMillionTokens: 2.5,
      outputUsdPerMillionTokens: 8.5,
      cachedInputPriceMultiplier: 0.5,
      sortOrder: 999,
    },
  });

  const model = await getEnabledRuntimeModel(modelId);
  assert.ok(model);
  assert.equal(model.apiModel, "registry-integration-v1");
  assert.equal(model.apiBaseUrl, "https://api.openai.com/v1");
  assert.equal(model.inputCapabilities?.image, true);
  assert.equal(model.contextWindowTokens, 32_000);
  assert.equal(getModelUsageProfile(model).credits, 7);
  assert.deepEqual(getModelBillingProfile(model), {
    maxOutputTokens: 3_000,
    reservationOutputTokens: 1_200,
    inputUsdPerMillionTokens: 2.5,
    outputUsdPerMillionTokens: 8.5,
    cachedInputPriceMultiplier: 0.5,
  });
});

test("stores limited availability and operational notes in the registry", async () => {
  await prisma.modelRegistryEntry.update({
    where: { id: modelId },
    data: {
      status: "limited",
      enabled: true,
      operationalReason: "Integration-test provider throttling",
      userVisibleNote: "This model is temporarily limited.",
    },
  });

  const model = await getEnabledRuntimeModel(modelId);
  assert.ok(model);
  assert.equal(model.status, "limited");
  assert.equal(model.operationalReason, "Integration-test provider throttling");
  assert.equal(model.userVisibleNote, "This model is temporarily limited.");
  assert.deepEqual(await assertModelRuntimeAvailable(modelId), {
    allowed: true,
    reason: "This model is temporarily limited.",
  });
});

test("catalogue removal preserves historical model resolution but blocks new calls", async () => {
  await prisma.modelRegistryEntry.update({
    where: { id: modelId },
    data: {
      catalogDeleted: true,
      publiclyListed: false,
      enabled: false,
      status: "disabled",
      replacementModelId: "gpt-5-4-mini",
    },
  });

  assert.equal(await getEnabledRuntimeModel(modelId), undefined);
  const historical = await getRuntimeModel(modelId);
  assert.ok(historical);
  assert.equal(historical.name, "Registry Integration Model");
  assert.equal(historical.replacementModelId, "gpt-5-4-mini");
  assert.equal(historical.catalogDeleted, true);
});
