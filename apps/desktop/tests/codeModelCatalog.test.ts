import assert from "node:assert/strict";
import test from "node:test";
import { SMART_ADAPTIVE_MODEL_ID, codePickerModel, codePickerModels } from "../src/code-model-catalog";
import { getModelUsageCredits } from "../../../lib/models";
import { desktopShellCopy } from "../../../locales/desktopShell";

const coder = { id: "catalogue-only-coder", name: "Catalogue Coder", provider: "openai", efforts: ["low", "high"], credits: 7, vision: true,
  reasoning: false, contextWindowTokens: 1_050_000 };

test("the Code picker lists the coding catalogue's own name, credits and capabilities", () => {
  const model = codePickerModel(coder, "{size} context window");
  assert.equal(model.name, "Catalogue Coder");
  assert.equal(model.provider, "openai");
  assert.equal(getModelUsageCredits(model), 7);
  assert.equal(model.bestFor, "1.05M context window");
  assert.equal(model.reasoning, "medium");
  assert.deepEqual(model.inputCapabilities, { image: true, nativePdf: false });
  assert.equal(model.minimumPlan, "Guest");
  assert.equal(model.webSearchOverride, "off");
  assert.equal(codePickerModel({ ...coder, efforts: [], contextWindowTokens: 128_000 }, "{size}").bestFor, "128K");
  assert.equal(codePickerModel({ id: "bare", name: "Bare", provider: "x", efforts: [] }, "{size}").bestFor, "");
});

test("Smart Adaptive is the picker's switch, never a row of the list", () => {
  const smart = { id: SMART_ADAPTIVE_MODEL_ID, name: "Smart Adaptive", provider: "tomverse", efforts: [] };
  assert.deepEqual(codePickerModels([smart, coder], "{size}").map(({ id }) => id), ["catalogue-only-coder"]);
});

test("every language says how large the context window is", () => {
  for (const [language, copy] of Object.entries(desktopShellCopy)) assert.match(copy.codeModelContext, /\{size\}/, language);
});
