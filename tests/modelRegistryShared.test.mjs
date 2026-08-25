import assert from "node:assert/strict";
import test from "node:test";
import {
  isApprovedProviderApiBaseUrl,
  isApprovedProviderApiKeyEnvName,
  isSafeProviderApiBaseUrl,
  normalizeApiBaseUrl,
  NARROW_SCOPE_RECONCILIATION_MODEL_IDS,
  OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS,
  PROVIDER_API_CONFIGURATION,
  RESERVATION_ONLY_RECONCILIATION_MODEL_IDS,
  STATIC_CATALOG_RECONCILIATION_MODEL_IDS,
  staticModelRegistryReconciliationRows,
} from "../lib/modelRegistryShared.ts";
import { AVAILABLE_MODELS, getModelUsageProfile } from "../lib/models.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";

test("provider registry defaults use public HTTPS endpoints and named environment keys", () => {
  for (const [provider, configuration] of Object.entries(
    PROVIDER_API_CONFIGURATION
  )) {
    assert.equal(isSafeProviderApiBaseUrl(configuration.baseUrl), true, provider);
    assert.match(configuration.apiKeyEnvName, /^[A-Z][A-Z0-9_]*$/);
  }
});

test("catalog reconciliation is exact-ID scoped and preserves operator-owned fields", () => {
  const rows = staticModelRegistryReconciliationRows();
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [...STATIC_CATALOG_RECONCILIATION_MODEL_IDS].sort()
  );

  for (const row of rows) {
    assert.equal("catalogDeleted" in row.data, false, row.id);
    assert.equal("sortOrder" in row.data, false, row.id);
    assert.equal("apiBaseUrl" in row.data, false, row.id);
    assert.equal("apiKeyEnvName" in row.data, false, row.id);
  }

  const active = rows.find((row) => row.id === "gemini-2-5-flash");
  assert.ok(active);
  assert.equal(active.data.apiModel, "gemini-3.5-flash-lite");
  assert.equal("enabled" in active.data, false);
  assert.equal("status" in active.data, false);

  const scout = rows.find((row) => row.id === "llama-4-scout");
  assert.ok(scout);
  assert.equal(scout.data.enabled, false);
  assert.equal(scout.data.publiclyListed, false);
  assert.equal(scout.data.status, "disabled");
  assert.equal(scout.data.replacementModelId, "gemini-3-6-flash");

  const legacyGemini = rows.find((row) => row.id === "gemini-3-5-flash");
  assert.ok(legacyGemini);
  assert.equal(legacyGemini.data.usageClass, "advanced");
  assert.equal(legacyGemini.data.creditWeight, 4);
  assert.equal(legacyGemini.data.enabled, false);
  assert.equal(legacyGemini.data.publiclyListed, false);
  assert.equal(legacyGemini.data.status, "disabled");
  assert.equal(legacyGemini.data.replacementModelId, "gemini-3-6-flash");

  // Each retired Llama hands off to a live model at its own tier, from
  // another provider -- Groq has none left. Every replacement here must be a
  // model this reconciliation is not itself retiring.
  for (const [modelId, replacementModelId] of [
    ["llama-3-1", "deepseek-v4-flash"],
    ["llama-3-3", "mistral-medium-3-1"],
  ]) {
    const llama = rows.find((row) => row.id === modelId);
    assert.ok(llama, modelId);
    assert.equal(llama.data.enabled, false, modelId);
    assert.equal(llama.data.publiclyListed, false, modelId);
    assert.equal(llama.data.status, "disabled", modelId);
    assert.equal(llama.data.replacementModelId, replacementModelId, modelId);
  }

  // xAI keeps only Grok 4.5, so every other Grok in scope is reconciled into
  // a retired row pointing at it.
  for (const modelId of ["grok-4", "grok-4-3", "grok-3", "grok-3-mini"]) {
    const grok = rows.find((row) => row.id === modelId);
    assert.ok(grok, modelId);
    assert.equal(grok.data.enabled, false, modelId);
    assert.equal(grok.data.replacementModelId, "grok-4-5", modelId);
  }

  const grok45 = rows.find((row) => row.id === "grok-4-5");
  assert.ok(grok45);
  assert.equal("enabled" in grok45.data, false);
  assert.equal("status" in grok45.data, false);
});

// Trace 2e4327a9: claude-sonnet-5 answered nothing and reported
// AI_EMPTY_RESPONSE.MAX_TOKENS because production still served it under the
// 4,096-token `advanced` class fallback its row was seeded with on
// 2026-07-17, five weeks before the 128,000 profile landed. Reconciliation is
// what carries the profile across to a row that already exists.
test("claude-sonnet-5 reconciles its output cap without moving credits or price", () => {
  const rows = staticModelRegistryReconciliationRows();
  const sonnet = rows.find((row) => row.id === "claude-sonnet-5");
  assert.ok(sonnet, "claude-sonnet-5 must be reconciled, or the 4,096 row stands");

  // The one number this entry exists to move.
  assert.equal(sonnet.data.maxOutputTokens, 128_000);
  // And the one it must not: the reservation is what a turn holds against the
  // user's credits and the provider budget, so it stays where the profile and
  // the row already agree. Raising it here would be an entitlement change
  // smuggled in as an incident fix (docs/policy/credit-and-cost-limits.md).
  assert.equal(sonnet.data.reservationOutputTokens, 2_048);

  // Sonnet 5 is enabled, so the lifecycle branch is not taken: an operator's
  // incident switch is not turned back on by an application restart.
  for (const field of [
    "enabled",
    "publiclyListed",
    "status",
    "operationalReason",
    "userVisibleNote",
    "replacementModelId",
  ]) {
    assert.equal(field in sonnet.data, false, field);
  }

  // Price stays NULL-means-inherit, and the credit weight stays the Advanced
  // class default the row was already billing at.
  for (const field of [
    "inputUsdPerMillionTokens",
    "outputUsdPerMillionTokens",
    "cachedInputPriceMultiplier",
    "updatedById",
    "updatedByEmail",
  ]) {
    assert.equal(field in sonnet.data, false, field);
  }
  assert.equal(sonnet.data.creditWeight, 4);
});

// The 2026-08-23 sweep that followed trace 2e4327a9: twelve more models whose
// rows were seeded before their pricing profile existed, so each holds a
// FALLBACK_PRICING class cap far below the profile. They are reconciled for
// that one column and nothing else -- see the block comment on
// OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS for why widening them would move
// figures that are under a hold.
test("a cap-only entry carries the output cap and nothing else", () => {
  const rows = staticModelRegistryReconciliationRows();

  for (const modelId of OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS) {
    const row = rows.find((entry) => entry.id === modelId);
    assert.ok(row, modelId);

    // Exactly one field. Asserted as the whole key set rather than field by
    // field, so a future field added to the shared payload cannot leak into
    // this scope unnoticed.
    assert.deepEqual(Object.keys(row.data), ["maxOutputTokens"], modelId);

    // And it is the profile's number, not the class fallback the row holds.
    const model = AVAILABLE_MODELS.find((entry) => entry.id === modelId);
    assert.ok(model, modelId);
    assert.equal(
      row.data.maxOutputTokens,
      resolveModelPricing({ ...model, maxOutputTokens: undefined })
        .maxOutputTokens,
      modelId
    );
  }
});

// docs/policy/perplexity-sonar-credit-price-hold.md: source says 16,
// production bills 20, and that document names this reconciliation list as
// the mechanism that would move the row. Until finance/product decide, an
// entry that wrote creditWeight would be a price change nobody approved.
test("cap-only entries never write a credit weight or a price", () => {
  const rows = staticModelRegistryReconciliationRows();
  const held = rows.find((entry) => entry.id === "perplexity/sonar");
  assert.ok(held);
  assert.equal("creditWeight" in held.data, false);
  assert.equal(getModelUsageProfile({ usageClass: "research" }).credits, 20);

  for (const modelId of OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS) {
    const row = rows.find((entry) => entry.id === modelId);
    for (const field of [
      "creditWeight",
      "reservationOutputTokens",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
      "cachedInputPriceMultiplier",
      "usageClass",
      "minimumPlan",
      "enabled",
      "publiclyListed",
      "status",
    ]) {
      assert.equal(field in row.data, false, `${modelId}.${field}`);
    }
  }
});

// The reservation-only scope is for a model whose cap already agrees, so the
// cap-only scope would carry nothing for it. Every figure it carries is
// already approved: docs/policy/credit-and-cost-limits.md section 4 sets the
// output reservation at "premium 4,096, reasoning 6,144 (maxOutputTokens
// 8,192)". A row holding the class fallback instead is holding a pre-profile
// seed value, not a decision.
const RESERVATION_ONLY_EXPECTATIONS = {
  // premium-reasoning, so section 4 says 6,144.
  "gpt-5-5-thinking": 6_144,
  // premium, so section 4 says 4,096. Its row holds 2,048 -- what
  // BILLING_DEFAULTS.premium read on 2026-07-17, before lib/modelPricing.ts
  // existed. Production provenance says seed on every axis: no actor columns,
  // updatedAt equal to createdAt, no AdminAuditLog row, and that timestamp
  // shared with other rows to the millisecond.
  "gpt-5-5": 4_096,
  "gemini-3-1-pro": 4_096,
};

test("every reservation-only model carries its approved figure and nothing else", () => {
  assert.deepEqual(
    [...RESERVATION_ONLY_RECONCILIATION_MODEL_IDS].sort(),
    Object.keys(RESERVATION_ONLY_EXPECTATIONS).sort()
  );

  const rows = staticModelRegistryReconciliationRows();
  for (const [modelId, approvedReservation] of Object.entries(
    RESERVATION_ONLY_EXPECTATIONS
  )) {
    assert.equal(
      OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS.includes(modelId),
      false,
      `${modelId}: its cap agrees, so the cap-only scope would carry nothing`
    );

    const model = AVAILABLE_MODELS.find((entry) => entry.id === modelId);
    assert.ok(model, modelId);
    const pricing = resolveModelPricing({
      ...model,
      maxOutputTokens: undefined,
      reservationOutputTokens: undefined,
    });
    // The premium class fallback and the profile agree on the cap (8,192) and
    // disagree only on the reservation. If a cap ever diverges too, that model
    // needs the other scope as well rather than silently keeping a stranded
    // ceiling.
    assert.equal(pricing.maxOutputTokens, 8_192, modelId);
    assert.equal(pricing.reservationOutputTokens, approvedReservation, modelId);
    // Section 3.1 of docs/policy/default-model-luna-migration.md governs
    // *moving* a model onto the p90 basis and needs nine conditions. Every
    // profile here already carried it when the section 4 figures were set, so
    // a model still on `conservative_default` must not appear in this scope.
    assert.equal(pricing.reservationOutputBasis, "p90_output_tokens", modelId);

    const row = rows.find((entry) => entry.id === modelId);
    assert.ok(row, modelId);
    assert.deepEqual(Object.keys(row.data), ["reservationOutputTokens"], modelId);
    assert.equal(row.data.reservationOutputTokens, approvedReservation, modelId);
  }
});

// The three models that diverge on reservation and are deliberately absent.
// Their profiles are still `conservative_default`, so section 4's figures were
// never set for them and there is no approved number to carry.
test("a conservative_default model never enters the reservation-only scope", () => {
  for (const modelId of [
    "mistral-large-3",
    "perplexity/sonar-deep-research",
    "qwen3.7-max",
  ]) {
    const model = AVAILABLE_MODELS.find((entry) => entry.id === modelId);
    assert.ok(model, modelId);
    const pricing = resolveModelPricing({
      ...model,
      maxOutputTokens: undefined,
      reservationOutputTokens: undefined,
    });
    assert.equal(
      pricing.reservationOutputBasis,
      "conservative_default",
      modelId
    );
    assert.equal(
      RESERVATION_ONLY_RECONCILIATION_MODEL_IDS.includes(modelId),
      false,
      modelId
    );
  }
});

// The narrow scopes exist to keep money columns out of a sweep. Neither may
// write a credit weight, a price, or a lifecycle field
// (docs/policy/perplexity-sonar-credit-price-hold.md).
test("neither narrow scope writes a credit weight, a price or a lifecycle field", () => {
  const rows = staticModelRegistryReconciliationRows();
  for (const modelId of NARROW_SCOPE_RECONCILIATION_MODEL_IDS) {
    const row = rows.find((entry) => entry.id === modelId);
    assert.ok(row, modelId);
    assert.equal(Object.keys(row.data).length, 1, modelId);
    for (const field of [
      "creditWeight",
      "inputUsdPerMillionTokens",
      "outputUsdPerMillionTokens",
      "cachedInputPriceMultiplier",
      "enabled",
      "publiclyListed",
      "status",
      "usageClass",
      "minimumPlan",
    ]) {
      assert.equal(field in row.data, false, `${modelId}.${field}`);
    }
  }
});

test("the two reconciliation scopes are disjoint and both reach the shared list", () => {
  const rows = staticModelRegistryReconciliationRows();
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    [...STATIC_CATALOG_RECONCILIATION_MODEL_IDS].sort()
  );

  const capOnly = new Set(OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS);
  assert.equal(capOnly.size, OUTPUT_CAP_ONLY_RECONCILIATION_MODEL_IDS.length);
  assert.equal(
    new Set(STATIC_CATALOG_RECONCILIATION_MODEL_IDS).size,
    STATIC_CATALOG_RECONCILIATION_MODEL_IDS.length,
    "a model must not appear in both scopes"
  );

  // A full-scope entry still carries its whole block, so narrowing one scope
  // did not quietly narrow the other.
  const full = rows.find((row) => row.id === "gpt-5-6-luna");
  assert.ok(full);
  assert.equal(full.data.creditWeight, 1);
  assert.equal(full.data.maxOutputTokens, 128_000);
  assert.equal(full.data.reservationOutputTokens, 4_096);
});

test("model registry URL validation blocks SSRF-oriented endpoints", () => {
  for (const value of [
    "http://api.example.com/v1",
    "https://localhost/v1",
    "https://127.0.0.1/v1",
    "https://10.1.2.3/v1",
    "https://192.168.1.20/v1",
    "https://169.254.169.254/latest/meta-data",
    "https://user:password@api.example.com/v1",
    "https://api.example.com/v1?secret=value",
  ]) {
    assert.equal(isSafeProviderApiBaseUrl(value), false, value);
  }
  assert.equal(isSafeProviderApiBaseUrl("https://gateway.example.com/v1"), true);
  assert.equal(normalizeApiBaseUrl("https://gateway.example.com/v1/"), "https://gateway.example.com/v1");
});

test("runtime provider connections accept only code-owned endpoint and key mappings", () => {
  for (const [provider, configuration] of Object.entries(PROVIDER_API_CONFIGURATION)) {
    assert.equal(
      isApprovedProviderApiBaseUrl(provider, configuration.baseUrl),
      true,
      provider
    );
    assert.equal(
      isApprovedProviderApiKeyEnvName(provider, configuration.apiKeyEnvName),
      true,
      provider
    );
    assert.equal(
      isApprovedProviderApiBaseUrl(provider, "https://attacker.example/collect"),
      false,
      provider
    );
    assert.equal(
      isApprovedProviderApiKeyEnvName(provider, "DATABASE_URL"),
      false,
      provider
    );
    assert.equal(
      isApprovedProviderApiKeyEnvName(provider, "STRIPE_SECRET_KEY"),
      false,
      provider
    );
  }
});
