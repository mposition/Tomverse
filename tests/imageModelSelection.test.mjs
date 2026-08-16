import assert from "node:assert/strict";
import test from "node:test";
import {
  IMAGE_GROUP_MAX_MODELS_BOUNDS,
  imageGroupMaxModels,
  resolveImageGroupMaxModels,
} from "../lib/imageGroupLimits.ts";
import {
  limitImageModelSelection,
  reportedImageModelLimit,
  toggleImageModelSelection,
} from "../lib/imageModelSelection.ts";
import { getImageModelPrice } from "../lib/imageModelRegistry.ts";

const OPENAI = "gpt-image-2";
const XAI = "grok-imagine-image-quality-20260403";
const FAL = "fal-ai/nano-banana-2";
const HELD = "gemini-3-pro-image";

/* -------------------------------------------------------------------------- */
/* The limit itself                                                           */
/* -------------------------------------------------------------------------- */

test("the limit falls back rather than clamping an out-of-range value", () => {
  assert.equal(resolveImageGroupMaxModels("3"), 3);
  assert.equal(resolveImageGroupMaxModels("4"), 4);
  // Above the ceiling: a deployment that asked for 9 meant something the
  // ceiling cannot honour, and quietly running at 4 would hide that.
  assert.equal(resolveImageGroupMaxModels("9"), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
  assert.equal(resolveImageGroupMaxModels("0"), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
  assert.equal(resolveImageGroupMaxModels("-1"), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
  assert.equal(resolveImageGroupMaxModels("2.5"), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
  assert.equal(resolveImageGroupMaxModels("three"), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
  assert.equal(resolveImageGroupMaxModels(undefined), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
});

test("1 resolves to 1, because the documented floor is guidance and not a parser rule", () => {
  // Pinned rather than corrected: the parser this replaced accepted it, so a
  // deployment may already rely on single-model requests. Changing it would be
  // an admission change wearing a refactor's clothes.
  assert.equal(resolveImageGroupMaxModels("1"), 1);
  assert.ok(IMAGE_GROUP_MAX_MODELS_BOUNDS.min > 1);
});

test("the limit is read from the environment at call time", () => {
  assert.equal(imageGroupMaxModels({ IMAGE_GROUP_MAX_MODELS: "3" }), 3);
  assert.equal(imageGroupMaxModels({}), IMAGE_GROUP_MAX_MODELS_BOUNDS.fallback);
});

/* -------------------------------------------------------------------------- */
/* Selecting                                                                  */
/* -------------------------------------------------------------------------- */

test("a third model is refused at maxModels=2, and nothing is swapped out", () => {
  const result = toggleImageModelSelection({
    selected: [OPENAI, XAI],
    modelId: FAL,
    maxModels: 2,
  });
  assert.deepEqual(result.modelIds, [OPENAI, XAI]);
  assert.equal(result.blockedByLimit, true);
});

test("all three fit at maxModels=3, and the total is the sum of the three prices", () => {
  let selection = [];
  for (const modelId of [OPENAI, XAI, FAL]) {
    const result = toggleImageModelSelection({
      selected: selection,
      modelId,
      maxModels: 3,
    });
    assert.equal(result.blockedByLimit, false);
    selection = result.modelIds;
  }
  assert.deepEqual(selection, [OPENAI, XAI, FAL]);

  // The number the composer quotes, computed the way the composer computes it.
  // Asserted against the registry rather than against a literal so a price
  // change fails the price test rather than this one.
  const total = selection.reduce(
    (sum, modelId) =>
      sum + (getImageModelPrice(modelId, "medium", "1024x1024")?.credits ?? 0),
    0
  );
  assert.equal(total, 265);
});

test("the last selected model cannot be deselected", () => {
  const result = toggleImageModelSelection({
    selected: [OPENAI],
    modelId: OPENAI,
    maxModels: 3,
  });
  assert.deepEqual(result.modelIds, [OPENAI]);
  // Not a limit refusal: the user is not being told about a ceiling here.
  assert.equal(result.blockedByLimit, false);
});

test("a selected model is still deselectable at the limit", () => {
  // The way out of "you have two of two" is to drop one, so this must work
  // precisely when the ceiling is reached.
  const result = toggleImageModelSelection({
    selected: [OPENAI, XAI],
    modelId: OPENAI,
    maxModels: 2,
  });
  assert.deepEqual(result.modelIds, [XAI]);
  assert.equal(result.blockedByLimit, false);
});

/* -------------------------------------------------------------------------- */
/* Restoring and seeding                                                      */
/* -------------------------------------------------------------------------- */

test("a restored selection over the limit is cut deterministically and names what it dropped", () => {
  const first = limitImageModelSelection({
    modelIds: [FAL, XAI, OPENAI],
    maxModels: 2,
  });
  // Registry order, so the same set always comes back the same way -- the
  // order it happened to arrive in carries no product meaning.
  const second = limitImageModelSelection({
    modelIds: [OPENAI, FAL, XAI],
    maxModels: 2,
  });
  assert.deepEqual(first.modelIds, second.modelIds);
  assert.equal(first.modelIds.length, 2);
  assert.equal(first.excludedModelIds.length, 1);
  assert.deepEqual(
    [...first.modelIds, ...first.excludedModelIds].sort(),
    [FAL, OPENAI, XAI].sort()
  );
});

test("a selection within the limit is returned whole, with nothing excluded", () => {
  const result = limitImageModelSelection({
    modelIds: [OPENAI, XAI],
    maxModels: 3,
  });
  assert.equal(result.modelIds.length, 2);
  assert.deepEqual(result.excludedModelIds, []);
});

test("duplicates collapse before the limit is applied", () => {
  // Otherwise the same model twice would consume two of the three seats.
  const result = limitImageModelSelection({
    modelIds: [OPENAI, OPENAI, XAI],
    maxModels: 2,
  });
  assert.deepEqual(result.modelIds, [OPENAI, XAI]);
  assert.deepEqual(result.excludedModelIds, []);
});

test("limiting reports, and never invents a substitute", () => {
  // A held model is the restore module's problem, not this one's: this only
  // decides how many fit. Passing one through unchanged is what keeps the two
  // reasons a model is missing separable in the notice.
  const result = limitImageModelSelection({
    modelIds: [HELD, OPENAI],
    maxModels: 1,
  });
  assert.equal(result.modelIds.length, 1);
  assert.equal(result.excludedModelIds.length, 1);
});

/* -------------------------------------------------------------------------- */
/* The server's refusal                                                       */
/* -------------------------------------------------------------------------- */

test("the server's own maxModels wins over the client's copy", () => {
  // The point of the detail: a stale tab believes 3 and admission applied 2.
  assert.equal(reportedImageModelLimit(2, 3), 2);
});

test("a malformed maxModels detail falls back to the client's runtime limit", () => {
  for (const bad of [undefined, null, "2", 0, -1, 2.5, Number.NaN, {}]) {
    assert.equal(reportedImageModelLimit(bad, 3), 3);
  }
});
