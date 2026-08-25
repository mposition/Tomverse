import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../../lib/prisma";
import {
  OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS,
  RESERVATION_ONLY_RECONCILIATION_MODEL_IDS,
  STATIC_RUNTIME_MODELS,
} from "../../lib/modelRegistryShared";
import {
  ensureModelRegistrySeeded,
  getEnabledRuntimeModel,
  getRuntimeModel,
  reconcileStaticCatalogMetadata,
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
  { id: "gemini-3-5-flash", replacementModelId: "gemini-3-6-flash" },
  { id: "grok-3", replacementModelId: "grok-4-5" },
  { id: "grok-3-mini", replacementModelId: "grok-4-5" },
  { id: "grok-4", replacementModelId: "grok-4-5" },
  { id: "llama-3-1", replacementModelId: "deepseek-v4-flash" },
  { id: "llama-3-3", replacementModelId: "mistral-medium-3-1" },
  { id: "llama-4-scout", replacementModelId: "gemini-3-6-flash" },
  { id: "codestral", replacementModelId: "mistral-medium-3-1" },
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
      provider: entry.id === "codestral"
        ? "mistral"
        : entry.id.startsWith("gemini")
          ? "google"
          : entry.id.startsWith("grok")
            ? "xai"
            : "groq",
      apiBaseUrl: entry.id === "codestral"
        ? "https://api.mistral.ai/v1"
        : entry.id.startsWith("gemini")
          ? "https://generativelanguage.googleapis.com/v1beta"
          : entry.id.startsWith("grok")
            ? "https://api.x.ai/v1"
            : "https://api.groq.com/openai/v1",
      apiKeyEnvName: entry.id === "codestral"
        ? "MISTRAL_API_KEY"
        : entry.id.startsWith("gemini")
          ? "GOOGLE_GENERATIVE_AI_API_KEY"
          : entry.id.startsWith("grok")
            ? "XAI_API_KEY"
            : "GROQ_API_KEY",
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

test("the launched and upgraded catalogue metadata reaches runtime rows", async () => {
  const kimi = await getEnabledRuntimeModel("kimi-k3");
  assert.ok(kimi, "kimi-k3 must be enabled after its one-time launch migration");
  assert.notEqual(kimi.publiclyListed, false);
  assert.equal(kimi.status, "enabled");
  assert.equal(getModelUsageProfile(kimi).credits, 16);
  assert.equal((await assertModelRuntimeAvailable("kimi-k3")).allowed, true);

  const fable = await getEnabledRuntimeModel("claude-fable-5");
  assert.ok(fable);
  // Explicit creditWeight of 20 since the 2026-08-04 re-weighting; the class
  // is still premium-reasoning, whose default would be 16.
  assert.equal(getModelUsageProfile(fable).credits, 20);

  const opus = await getEnabledRuntimeModel("claude-opus-4-8");
  assert.ok(opus);
  assert.equal(opus.name, "Claude Opus 5");
  assert.equal(opus.apiModel, "claude-opus-5");

  const minimax = await getEnabledRuntimeModel("minimax-m3");
  assert.ok(minimax);
  assert.equal(minimax.provider, "minimax");
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
    "gemini-3-6-flash",
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
// over STATIC_WITHDRAWN_MODELS, reconcileStaticCatalogMetadata over
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

// Trace 2e4327a9: claude-sonnet-5 returned no answer at all and reported
// AI_EMPTY_RESPONSE.MAX_TOKENS. 16,314 input tokens went out, 4,096 output
// tokens were allowed, 4,095 of them went to reasoning, and the turn ended
// before a word of visible text or a single tool call.
//
// 4,096 was FALLBACK_PRICING.advanced, written into the row when it was seeded
// on 2026-07-17 -- claude-sonnet-5 had no pricing profile then. The profile
// arrived on 2026-08-04 saying 128,000 and never reached the row:
// `createMany({ skipDuplicates: true })` does not revisit an existing row, and
// the model was not in STATIC_CATALOG_RECONCILIATION_MODEL_IDS. Unlike the
// three price columns there is no NULL-means-inherit rule here to save it --
// `registryRowToModel()` simply obeys the stored number.
//
// This plants the production shape and checks the bootstrap corrects it,
// including the fields it must NOT touch on the way past.
test("bootstrapping lifts a stale Sonnet 5 output cap without touching price, credits or availability", async () => {
  const before = await prisma.modelRegistryEntry.findUniqueOrThrow({
    where: { id: "claude-sonnet-5" },
  });

  await prisma.modelRegistryEntry.update({
    where: { id: "claude-sonnet-5" },
    data: {
      // The fossil.
      maxOutputTokens: 4_096,
      reservationOutputTokens: 2_048,
      // Fields an operator owns, planted so a reconciliation that reached too
      // far is caught here rather than in production. The price columns are a
      // stored number, which by contract means "an administrator overrode this
      // model" and beats the profile including its tiers.
      inputUsdPerMillionTokens: 9.5,
      outputUsdPerMillionTokens: 42.5,
      cachedInputPriceMultiplier: 0.25,
      updatedById: null,
      updatedByEmail: "ops@tomverse.app",
      sortOrder: 4_242,
      catalogDeleted: false,
    },
  });

  // The bootstrap memoises, so the reconciliation is invoked directly -- which
  // is also how an operator repairs one environment without a deploy.
  await reconcileStaticCatalogMetadata();

  const row = await prisma.modelRegistryEntry.findUniqueOrThrow({
    where: { id: "claude-sonnet-5" },
  });

  // The one number this is for.
  assert.equal(row.maxOutputTokens, 128_000);
  // And the one that must not move with it: what a turn reserves against the
  // user's credits and the provider budget is an entitlement decision, not
  // something an incident fix carries along
  // (docs/policy/credit-and-cost-limits.md).
  assert.equal(row.reservationOutputTokens, 2_048);

  // The administrator's price override survives, tiers and all.
  assert.equal(Number(row.inputUsdPerMillionTokens), 9.5);
  assert.equal(Number(row.outputUsdPerMillionTokens), 42.5);
  assert.equal(Number(row.cachedInputPriceMultiplier), 0.25);
  // As does everything else the operator owns.
  assert.equal(row.updatedByEmail, "ops@tomverse.app");
  assert.equal(row.sortOrder, 4_242);
  assert.equal(row.catalogDeleted, false);
  // Sonnet 5 is enabled, so the lifecycle branch is not taken and the model
  // stays exactly as available as it was.
  assert.equal(row.enabled, before.enabled);
  assert.equal(row.publiclyListed, before.publiclyListed);
  assert.equal(row.status, before.status);
  assert.equal(row.creditWeight, 4);

  // What the request actually asks for, read back through the same path the
  // chat route uses. The stored override is what makes this worth asserting:
  // resolveModelPricing() prefers row values, so a run that only checked the
  // profile would pass while production still capped at 4,096.
  const model = await getEnabledRuntimeModel("claude-sonnet-5");
  assert.ok(model);
  assert.equal(model.maxOutputTokens, 128_000);
  assert.equal(getModelBillingProfile(model).maxOutputTokens, 128_000);
  assert.equal(getModelBillingProfile(model).reservationOutputTokens, 2_048);
  assert.equal(getModelUsageProfile(model).credits, 4);

  // Idempotent: a second pass writes nothing and changes nothing.
  await reconcileStaticCatalogMetadata();
  const again = await prisma.modelRegistryEntry.findUniqueOrThrow({
    where: { id: "claude-sonnet-5" },
  });
  assert.equal(again.maxOutputTokens, 128_000);
  assert.equal(again.reservationOutputTokens, 2_048);
  assert.equal(Number(again.inputUsdPerMillionTokens), 9.5);

  // Put the row back the way the suite found it: the price columns are NULL
  // in a real deployment, and leaving an override behind would quietly change
  // what every later test in this database is priced at.
  await prisma.modelRegistryEntry.update({
    where: { id: "claude-sonnet-5" },
    data: {
      inputUsdPerMillionTokens: before.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: before.outputUsdPerMillionTokens,
      cachedInputPriceMultiplier: before.cachedInputPriceMultiplier,
      updatedById: before.updatedById,
      updatedByEmail: before.updatedByEmail,
      sortOrder: before.sortOrder,
    },
  });
});

// The 2026-08-23 sweep found twelve more rows in the same shape, and one of
// them is the model docs/policy/perplexity-sonar-credit-price-hold.md was
// written about: source says creditWeight 16, production bills 20, and that
// hold forbids moving either until finance/product decide. Full-scope
// reconciliation writes creditWeight, so these twelve are reconciled for the
// output cap alone. This plants both halves of that conflict and checks the
// cap moves while the held credit weight does not.
test("a cap-only reconciliation lifts the output cap and leaves the held credit weight alone", async () => {
  const before = await prisma.modelRegistryEntry.findUniqueOrThrow({
    where: { id: "perplexity/sonar" },
  });

  await prisma.modelRegistryEntry.update({
    where: { id: "perplexity/sonar" },
    data: {
      // The pre-profile seed: FALLBACK_PRICING.research would have written
      // 4,096 / 2,048 before the 2026-08-04 profile existed.
      maxOutputTokens: 4_096,
      reservationOutputTokens: 2_048,
      // What production actually bills, and what the hold protects. The
      // catalogue says 16; if this comes back 16, a price change nobody
      // approved has shipped.
      creditWeight: 20,
      bestFor: "an operator's own wording",
      sortOrder: 4_243,
    },
  });

  await reconcileStaticCatalogMetadata();

  const row = await prisma.modelRegistryEntry.findUniqueOrThrow({
    where: { id: "perplexity/sonar" },
  });

  assert.equal(row.maxOutputTokens, 128_000);
  assert.equal(
    row.creditWeight,
    20,
    "the Perplexity Sonar credit hold forbids this row moving to the catalogue's 16"
  );
  // The reservation is an entitlement figure and is outside this scope, so it
  // keeps whatever the row held rather than being refreshed alongside the cap.
  assert.equal(row.reservationOutputTokens, 2_048);
  // And nothing else in the metadata block is carried either.
  assert.equal(row.bestFor, "an operator's own wording");
  assert.equal(row.sortOrder, 4_243);
  assert.equal(row.enabled, before.enabled);
  assert.equal(row.publiclyListed, before.publiclyListed);

  // What the request actually asks for, through the same path chat uses.
  const model = await getEnabledRuntimeModel("perplexity/sonar");
  assert.ok(model);
  assert.equal(getModelBillingProfile(model).maxOutputTokens, 128_000);
  assert.equal(getModelUsageProfile(model).credits, 20);

  await prisma.modelRegistryEntry.update({
    where: { id: "perplexity/sonar" },
    data: {
      creditWeight: before.creditWeight,
      bestFor: before.bestFor,
      sortOrder: before.sortOrder,
      reservationOutputTokens: before.reservationOutputTokens,
    },
  });
});

// Every model in the narrow scope, end to end: a pre-profile row goes in, the
// approved cap comes out, and the row's credit weight is untouched.
test("every cap-only model has its stranded cap lifted by the bootstrap", async () => {
  const ids = [...OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS];
  const originals = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: ids } },
  });
  assert.equal(originals.length, ids.length, "all cap-only models must be seeded");

  // A distinctive credit weight per row, so a reconciliation that reached the
  // column would be visible rather than coincidentally correct.
  const sentinelCreditWeight = 97;
  await prisma.modelRegistryEntry.updateMany({
    where: { id: { in: ids } },
    data: { maxOutputTokens: 1_024, creditWeight: sentinelCreditWeight },
  });

  await reconcileStaticCatalogMetadata();

  const rows = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: ids } },
  });
  for (const row of rows) {
    const expected = STATIC_RUNTIME_MODELS.find((model) => model.id === row.id);
    assert.ok(expected, row.id);
    assert.equal(row.maxOutputTokens, expected.maxOutputTokens, row.id);
    assert.ok(row.maxOutputTokens! > 1_024, row.id);
    assert.equal(row.creditWeight, sentinelCreditWeight, row.id);
  }

  for (const original of originals) {
    await prisma.modelRegistryEntry.update({
      where: { id: original.id },
      data: {
        maxOutputTokens: original.maxOutputTokens,
        creditWeight: original.creditWeight,
      },
    });
  }
});

// The reservation-only scope, end to end. This is the one narrow entry that
// moves a money figure, so what it must NOT touch is worth pinning as firmly
// as what it does: docs/policy/credit-and-cost-limits.md section 4 approved
// the held figures, and nothing else about those rows was approved with them.
//
// Every model in the scope is exercised, not just the first. The scope grew on
// 2026-08-25 and this test still named one model, which is the shape of test
// that reports a widened money path as green.
test("the reservation-only scope raises the held figure and leaves the cap and credits alone", async () => {
  const ids = [...RESERVATION_ONLY_RECONCILIATION_MODEL_IDS];
  // Frozen deliberately. Adding a model here moves what an account is
  // guaranteed, so it is an edit that must be made twice -- once in the scope
  // and once in the test that says which rows the scope covers.
  assert.deepEqual(ids, ["gpt-5-5-thinking", "gpt-5-5", "gemini-3-1-pro"]);

  const originals = await prisma.modelRegistryEntry.findMany({
    where: { id: { in: ids } },
  });
  assert.equal(
    originals.length,
    ids.length,
    "all reservation-only models must be seeded"
  );

  for (const original of originals) {
    await prisma.modelRegistryEntry.update({
      where: { id: original.id },
      data: {
        // Below every approved figure in the scope, so a reconciliation that
        // did nothing cannot pass by coincidence. The real fossils differ per
        // row -- 4,096 on the premium fallback, 2,048 from the 2026-07-17
        // seed -- and a shared sentinel is what lets one assertion cover all
        // of them.
        reservationOutputTokens: 1_024,
        // Deliberately wrong, and deliberately left wrong: this scope carries
        // the reservation only, so an operator's cap survives it.
        maxOutputTokens: 7_000,
        creditWeight: 31,
        inputUsdPerMillionTokens: 11.5,
        updatedByEmail: "ops@tomverse.app",
      },
    });
  }

  await reconcileStaticCatalogMetadata();

  for (const original of originals) {
    const expected = STATIC_RUNTIME_MODELS.find(
      (model) => model.id === original.id
    );
    assert.ok(expected, original.id);
    const row = await prisma.modelRegistryEntry.findUniqueOrThrow({
      where: { id: original.id },
    });
    assert.equal(
      row.reservationOutputTokens,
      expected.reservationOutputTokens,
      original.id
    );
    assert.ok(row.reservationOutputTokens! > 1_024, original.id);
    assert.equal(
      row.maxOutputTokens,
      7_000,
      "the cap is outside this scope, so even a wrong one is left for a human"
    );
    assert.equal(row.creditWeight, 31, original.id);
    assert.equal(Number(row.inputUsdPerMillionTokens), 11.5, original.id);
    assert.equal(row.updatedByEmail, "ops@tomverse.app", original.id);
    assert.equal(row.enabled, original.enabled, original.id);
    assert.equal(row.status, original.status, original.id);
  }

  // Idempotent.
  await reconcileStaticCatalogMetadata();
  for (const original of originals) {
    const expected = STATIC_RUNTIME_MODELS.find(
      (model) => model.id === original.id
    );
    const again = await prisma.modelRegistryEntry.findUniqueOrThrow({
      where: { id: original.id },
    });
    assert.equal(
      again.reservationOutputTokens,
      expected!.reservationOutputTokens,
      original.id
    );
    assert.equal(again.creditWeight, 31, original.id);
  }

  for (const original of originals) {
    await prisma.modelRegistryEntry.update({
      where: { id: original.id },
      data: {
        maxOutputTokens: original.maxOutputTokens,
        reservationOutputTokens: original.reservationOutputTokens,
        creditWeight: original.creditWeight,
        inputUsdPerMillionTokens: original.inputUsdPerMillionTokens,
        updatedByEmail: original.updatedByEmail,
      },
    });
  }
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
  // An operator's own note survives on a model that still answers -- a note
  // explaining throttling is exactly that case -- and travels as their words
  // rather than as a copy key, because nothing can translate it (EM-15).
  assert.deepEqual(await assertModelRuntimeAvailable(modelId), {
    allowed: true,
    reason: "This model is temporarily limited.",
    notice: {
      source: "operator",
      text: "This model is temporarily limited.",
    },
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
