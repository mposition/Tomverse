import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

import { CODE_PINNED_MODELS, codePinnedModelRefusal } from "../lib/codePinnedModels.ts";
import { PROMPT_REFINER_PRODUCT_PRICE_PIN } from "../lib/promptRefinerProductPricePin.ts";
import { PROMPT_REFINER_EXECUTION_MODEL_PIN } from "../lib/promptRefinerExecutionContract.ts";
import { PROMPT_REFINER_VNEXT_PRICE_PIN } from "../lib/promptRefinerQualityEvaluationVnextExecutionContract.ts";

// 2026-11-11: disabling the price-pinned model closed Chat for every account.
test("the product pin Chat runs on is protected; evaluation pins are not", () => {
  const pinned = new Set(CODE_PINNED_MODELS.map((pin) => pin.modelId));
  assert.ok(pinned.has(PROMPT_REFINER_PRODUCT_PRICE_PIN.modelId));
  assert.equal(PROMPT_REFINER_PRODUCT_PRICE_PIN.modelId, "gpt-6-luna");
  // The evaluation records stay on gpt-5-6-luna and must not block its retirement.
  assert.equal(pinned.has(PROMPT_REFINER_VNEXT_PRICE_PIN.modelId), false);
  assert.equal(pinned.has(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId), false);
});

test("a pinned model may be edited, but nothing the Chat price readback refuses", () => {
  const id = PROMPT_REFINER_PRODUCT_PRICE_PIN.modelId;
  const untouched = {
    modelId: id,
    status: "enabled",
    publiclyListed: true,
    replacementModelId: null,
    inputUsdPerMillionTokens: null,
    outputUsdPerMillionTokens: null,
    cachedInputPriceMultiplier: null,
  };
  assert.equal(codePinnedModelRefusal(untouched), null);
  // The readback requires status "enabled" exactly, so "limited" breaks it too.
  for (const status of ["disabled", "coming-soon", "limited"]) {
    assert.match(codePinnedModelRefusal({ ...untouched, status }) ?? "", /changing its status/, status);
  }
  assert.match(codePinnedModelRefusal({ ...untouched, publiclyListed: false }) ?? "", /unlisting/);
  assert.match(codePinnedModelRefusal({ ...untouched, replacementModelId: "gpt-6-1-luna" }) ?? "", /replacement/);
  assert.match(codePinnedModelRefusal({ ...untouched, outputUsdPerMillionTokens: 1 }) ?? "", /price/);
  // Identity and the contract's output floor (review r-20261111-101129-ba58bd).
  const pin = PROMPT_REFINER_PRODUCT_PRICE_PIN;
  assert.equal(
    codePinnedModelRefusal({ ...untouched, provider: pin.provider, apiModel: pin.apiModelId, maxOutputTokens: 4_096, reservationOutputTokens: null }),
    null
  );
  assert.match(codePinnedModelRefusal({ ...untouched, provider: "anthropic" }) ?? "", /provider or upstream/);
  assert.match(codePinnedModelRefusal({ ...untouched, apiModel: "something-else" }) ?? "", /provider or upstream/);
  assert.match(codePinnedModelRefusal({ ...untouched, maxOutputTokens: 1 }) ?? "", /output below/);
  assert.match(codePinnedModelRefusal({ ...untouched, reservationOutputTokens: 4_095 }) ?? "", /output below/);
  assert.match(codePinnedModelRefusal({ modelId: id, catalogDeleted: true }) ?? "", /Move the pin/);
  // Anything not pinned is the registry's own business.
  assert.equal(codePinnedModelRefusal({ modelId: "not-pinned-model", status: "disabled" }), null);
});

// Every writer that can switch a registry row's status, listing, mapping or
// price. Review r-20261111-102757-237c36 found the incident route missing.
test("every path that can switch a model off asks the pin check first", () => {
  const perModel = readFileSync("app/api/admin/models/[modelId]/route.ts", "utf8");
  // PATCH (status, listing, mapping, price, caps) and DELETE (catalogue removal).
  assert.equal(perModel.split("codePinnedModelRefusal(").length - 1, 2);
  // Omitted fields are checked at their stored value, not skipped.
  assert.ok(perModel.includes("maxOutputTokens: kept(body.maxOutputTokens, stored?.maxOutputTokens)"));
  const registry = readFileSync("app/api/admin/models/route.ts", "utf8");
  assert.ok(registry.includes("codePinnedRefusal: codePinnedModelRefusal({ modelId: replacesModelId"));
  const incidents = readFileSync("app/api/admin/incidents/route.ts", "utf8");
  assert.ok(incidents.includes("pinnedLeftAsIs = scopedModels.filter"));
  assert.ok(incidents.includes("const targetModels = scopedModels.filter((model) => !pinnedLeftAsIs.includes(model))"));
  const reconciliation = readFileSync("lib/providerModelCatalogReconciliation.ts", "utf8");
  assert.ok(reconciliation.includes("provider_model_catalog_pinned_model_kept"));
  // No other registry status writer appeared without a decision about pins.
  const writers = execFileSync(
    "git",
    ["grep", "-l", "-E", "modelRegistryEntry[.](update|updateMany|upsert)[(]", "--", "app", "lib"],
    { encoding: "utf8" }
  ).trim().split("\n").map((file) => file.trim())
    .filter((file) => !file.includes(".test.")).sort();
  assert.deepEqual(writers, [
    "app/api/admin/incidents/route.ts",
    "app/api/admin/models/[modelId]/route.ts",
    "app/api/admin/models/route.ts",
    "lib/modelRegistry.ts",
    "lib/providerModelCatalogReconciliation.ts",
  ], "a new registry writer must decide whether pinned models need the pin check");
});
