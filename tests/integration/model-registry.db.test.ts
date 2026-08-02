import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import {
  ensureModelRegistrySeeded,
  getEnabledRuntimeModel,
  getRuntimeModel,
  reconcileStaticWithdrawals,
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
  // Same pre-state for the pre-launch model, so this one bootstrap covers
  // both halves of the withdrawal replay -- see the test below, which reads
  // the result rather than seeding a second time.
  await prisma.modelRegistryEntry.updateMany({
    where: { id: "kimi-k3" },
    data: { enabled: true, publiclyListed: true, status: "enabled" },
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

// A model withheld before launch has the same failure mode as a retired one:
// if an environment received a build that had it enabled, nothing would ever
// correct the row. The replay therefore covers it too -- and must write
// "coming-soon" rather than flattening it into "disabled", because the two
// states mean opposite things to an operator reading the registry. Reads the
// state the bootstrap above already produced; the bootstrap memoises, so
// there is exactly one replay per process to observe.
test("the same bootstrap withdraws a pre-launch model without marking it retired", async () => {
  const row = await prisma.modelRegistryEntry.findUnique({
    where: { id: "kimi-k3" },
  });
  assert.ok(row, "kimi-k3 must stay registered");
  assert.equal(row.enabled, false);
  assert.equal(row.publiclyListed, false);
  assert.equal(row.status, "coming-soon");
  assert.equal(row.catalogDeleted, false);
  // Withheld, not retired: it has no predecessor to hand users off to.
  assert.equal(row.replacementModelId, null);

  assert.equal(await getEnabledRuntimeModel("kimi-k3"), undefined);
  assert.equal((await assertModelRuntimeAvailable("kimi-k3")).allowed, false);
});

// The defect this covers: the withdrawal replay used to express "needs
// correcting" as a WHERE clause over enabled/publiclyListed/status, so a row
// that was already withdrawn but pointed at a replacement the catalogue has
// since changed was invisible to it. llama-4-scout was in exactly that shape
// -- disabled, delisted, and still handing users llama-3-3 after llama-3-3 was
// retired underneath it.
test("an already-withdrawn row with a stale replacement is still corrected", async () => {
  await prisma.modelRegistryEntry.update({
    where: { id: "llama-4-scout" },
    data: {
      enabled: false,
      publiclyListed: false,
      status: "disabled",
      // The value production actually held: a replacement that is itself
      // retired, so the row satisfied every lifecycle check while offering
      // users a dead end.
      replacementModelId: "llama-3-3",
    },
  });

  // ensureModelRegistrySeeded memoises, so the reconciliation is invoked
  // directly -- which is also how an operator would repair an environment.
  await reconcileStaticWithdrawals();

  const row = await prisma.modelRegistryEntry.findUnique({
    where: { id: "llama-4-scout" },
  });
  assert.ok(row);
  assert.equal(
    row.replacementModelId,
    "gemini-3-5-flash",
    "a stale replacement on an already-withdrawn row must still be corrected"
  );

  // And the replacement it now names is one a user can actually select.
  const replacement = await getEnabledRuntimeModel(row.replacementModelId!);
  assert.ok(replacement, "the corrected replacement must be enabled at runtime");
  assert.notEqual(replacement.publiclyListed, false);
});

// The one shape the withdrawal replay cannot cover, pinned so the next person
// who deletes a catalogue entry finds it here rather than in production.
//
// Both replay paths iterate the static catalogue -- reconcileStaticWithdrawals
// over STATIC_WITHDRAWN_MODELS, applyScopedStaticCatalogReconciliation over
// filtered seed rows -- so an id removed outright leaves nothing to iterate,
// while getRuntimeModels keeps answering from the row. Deleting an entry
// therefore does NOT withdraw the model from an environment that already
// seeded it. groq-gpt-oss-120b shipped in release #225 and was deleted in
// #180; migration 20260801200000 is what actually withdraws it.
test("deleting a catalogue entry does not withdraw its runtime row", async () => {
  const orphanId = `integration/orphan-${randomUUID()}`;
  await prisma.modelRegistryEntry.create({
    data: {
      id: orphanId,
      name: "Orphaned Model",
      apiModel: "orphaned-model",
      provider: "groq",
      apiBaseUrl: "https://api.groq.com/openai/v1",
      apiKeyEnvName: "GROQ_API_KEY",
      icon: "GR",
      bestFor: "an id with no catalogue entry behind it",
      minimumPlan: "Free",
      usageClass: "advanced",
      creditWeight: 4,
      enabled: true,
      publiclyListed: true,
      status: "enabled",
    },
  });

  try {
    await reconcileStaticWithdrawals();

    const row = await prisma.modelRegistryEntry.findUnique({
      where: { id: orphanId },
    });
    assert.ok(row);
    assert.equal(
      row.enabled,
      true,
      "the replay cannot reach an id the catalogue no longer carries -- removing an entry needs a targeted migration, not a delete"
    );

    const runtime = await getEnabledRuntimeModel(orphanId);
    assert.ok(
      runtime,
      "and the model keeps being served, because getRuntimeModels answers from the row"
    );
  } finally {
    await prisma.modelRegistryEntry.deleteMany({ where: { id: orphanId } });
  }
});

test("the shipped GPT-OSS row is withdrawn by migration, not left offerable", async () => {
  // 20260801200000 runs against a database that has one; here it has none, so
  // this asserts the end state either way: no environment serves it.
  const runtime = await getEnabledRuntimeModel("groq-gpt-oss-120b");
  assert.equal(runtime, undefined);
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
