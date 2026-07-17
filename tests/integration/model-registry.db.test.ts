import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import {
  ensureModelRegistrySeeded,
  getEnabledRuntimeModel,
  getRuntimeModel,
} from "../../lib/modelRegistry";
import { getModelBillingProfile, getModelUsageProfile } from "../../lib/models";

const modelId = `integration/model-${randomUUID()}`;

after(async () => {
  await prisma.modelOverride.deleteMany({ where: { modelId } });
  await prisma.modelRegistryEntry.deleteMany({ where: { id: modelId } });
  await prisma.$disconnect();
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
