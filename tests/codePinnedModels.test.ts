import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { CODE_PINNED_MODELS, codePinnedModelRefusal } from "../lib/codePinnedModels.ts";
import { PROMPT_REFINER_EXECUTION_MODEL_PIN } from "../lib/promptRefinerExecutionContract.ts";
import { PROMPT_REFINER_VNEXT_PRICE_PIN } from "../lib/promptRefinerQualityEvaluationVnextExecutionContract.ts";

// 2026-11-11: disabling the price-pinned model closed Chat for every account.
test("every Prompt Refiner pin is protected, and follows the pin when it moves", () => {
  const pinned = new Set(CODE_PINNED_MODELS.map((pin) => pin.modelId));
  assert.ok(pinned.has(PROMPT_REFINER_VNEXT_PRICE_PIN.modelId));
  assert.ok(pinned.has(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId));
});

test("a pinned model may be edited, but nothing the Chat price readback refuses", () => {
  const id = PROMPT_REFINER_VNEXT_PRICE_PIN.modelId;
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
  assert.match(codePinnedModelRefusal({ ...untouched, replacementModelId: "gpt-6-luna" }) ?? "", /replacement/);
  assert.match(codePinnedModelRefusal({ ...untouched, outputUsdPerMillionTokens: 1 }) ?? "", /price/);
  assert.match(codePinnedModelRefusal({ modelId: id, catalogDeleted: true }) ?? "", /Move the pin/);
  // Anything not pinned is the registry's own business.
  assert.equal(codePinnedModelRefusal({ modelId: "not-pinned-model", status: "disabled" }), null);
});

test("every Admin path that switches a model off asks the pin check first", () => {
  const perModel = readFileSync("app/api/admin/models/[modelId]/route.ts", "utf8");
  // PATCH (status) and DELETE (catalogue removal).
  assert.equal(perModel.match(/codePinnedModelRefusal\(/g)?.length, 2);
  const registry = readFileSync("app/api/admin/models/route.ts", "utf8");
  // Adoption that replaces (and disables) an existing model.
  assert.match(registry, /codePinnedRefusal: codePinnedModelRefusal\(\{ modelId: replacesModelId/);
});
