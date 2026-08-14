import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_IMAGE_MODEL_ID,
  IMAGE_MODEL_REGISTRY,
  getImageModel,
  getImageModelPrice,
  listActiveImageProviders,
  listEnabledImageModels,
  maxImageRequestCostMicroUsd,
  minimumCreditsForImageOption,
  imageComposerModelLayout,
  imageDeliveryMimeType,
  imageModelChipLabel,
  imageModelBrandParts,
  imageModelOwner,
  shouldUseCompactImageModelPicker,
  IMAGE_INLINE_MODEL_DISCOVERY_LIMIT,
} from "../lib/imageModelRegistry.ts";
import { imageProviderBudgetEnvNames } from "../lib/imageProviderBudget.ts";
import { evaluateFalPricing } from "../scripts/check-fal-image-pricing-core.mjs";
import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_PROMPT_BUDGET_MICRO_USD,
} from "../lib/imageGenerationPricing.ts";

test("the registry ships GPT Image 2 enabled and Nano Banana 2 on a verification hold", () => {
  const openai = getImageModel("gpt-image-2");
  assert.equal(openai?.provider, "openai");
  assert.equal(openai?.disabledReason, null);
  assert.equal(openai?.lifecycle, "stable");
  assert.equal(DEFAULT_IMAGE_MODEL_ID, "gpt-image-2");

  const google = getImageModel("gemini-3.1-flash-image");
  assert.equal(google?.provider, "google");
  assert.equal(google?.lifecycle, "stable");
  // Policy section 12: the per-image price was read from Google's own
  // documentation on 2026-08-04, but thinking cannot be disabled and no token
  // cap is established -- so the worst case is not provably finite and the
  // reason says exactly that rather than claiming the price is unknown.
  assert.equal(google?.disabledReason, "worst_case_cost_unbounded");
  assert.equal(google?.priceVerification.verifiedAt, "2026-08-04");
  assert.equal(google?.priceVerification.thinkingCapMicroUsd, null);
  assert.deepEqual(google?.prices, []);
});

test("Grok Imagine ships enabled at the approved price, 1K square only", () => {
  // Enabled 2026-08-05, after the operational hold was cleared in order: the
  // adapter, then the provider budget deployed ahead of this code. The price
  // question was already settled -- flat per-image, no token charges -- which
  // is why the approved credits were recorded while it was still held rather
  // than typed in by hand on launch day.
  const grok = getImageModel("grok-imagine-image-quality-20260403");
  assert.equal(grok?.disabledReason, null);
  assert.equal(grok?.priceVerification.verifiedAt, "2026-08-04");
  assert.equal(grok?.priceVerification.thinkingCapMicroUsd, 0);
  assert.deepEqual(grok?.prices, [
    {
      quality: "medium",
      size: "1024x1024",
      credits: 75,
      outputCostMicroUsd: 50_000,
    },
  ]);
  assert.ok(
    grok.prices[0].credits >= minimumCreditsForImageOption(grok, grok.prices[0])
  );
  assert.deepEqual(
    getImageModelPrice("grok-imagine-image-quality-20260403", "medium", "1024x1024"),
    grok.prices[0]
  );

  // 2K is approved at 100 credits and deliberately absent: it needs the size
  // system to grow a resolution tier first. Every other option prices to null,
  // so the composer disables submission rather than quoting a guess.
  assert.deepEqual(grok.sizes, ["1024x1024"]);
  assert.deepEqual(grok.qualities, ["medium"]);
  for (const [quality, size] of [
    ["low", "1024x1024"],
    ["high", "1024x1024"],
    ["medium", "1536x1024"],
    ["medium", "1024x1536"],
  ]) {
    assert.equal(
      getImageModelPrice("grok-imagine-image-quality-20260403", quality, size),
      null,
      `${quality} ${size}`
    );
  }

  // Verified absent, not unread: no watermark, C2PA or metadata guarantee
  // anywhere in xAI's documentation. Claiming provenance a file may not carry
  // would be worse than claiming none.
  assert.deepEqual(grok.provenance, []);
});

test("a disabled model is invisible to every selection path", () => {
  const enabled = listEnabledImageModels().map((model) => model.id);
  assert.deepEqual(enabled, [
    "gpt-image-2",
    "grok-imagine-image-quality-20260403",
    "fal-ai/nano-banana-2",
  ]);
  // Three providers now. The list is spelled out rather than counted because
  // adding a provider is the change that turns budgets, concurrency buckets
  // and readiness on for it, and that should never happen as a side effect of
  // an edit somewhere else. The three Google models are registered and still
  // contribute no provider here: `google` is the model *owner* of the fal row,
  // and owner is not provider.
  assert.deepEqual(listActiveImageProviders(), ["openai", "xai", "fal"]);
  // Fail-closed price lookup: the model exists, but pricing it is refused.
  assert.equal(
    getImageModelPrice("gemini-3.1-flash-image", "medium", "1024x1024"),
    null
  );
  assert.equal(getImageModelPrice("unknown-model", "low", "1024x1024"), null);
});

test("worst-case cost is null when the thinking cap is unknown", () => {
  const google = getImageModel("gemini-3.1-flash-image");
  const hypotheticalPrice = {
    quality: "medium",
    size: "1024x1024",
    credits: 80,
    outputCostMicroUsd: 67_000,
  };
  // Even handed a price, an unknown cap cannot produce a finite worst case,
  // so no fixed credit figure can be derived from it.
  assert.equal(maxImageRequestCostMicroUsd(google, hypotheticalPrice), null);
  assert.equal(minimumCreditsForImageOption(google, hypotheticalPrice), null);
});

test("every enabled option prices at or above the policy minimum", () => {
  for (const model of listEnabledImageModels()) {
    for (const price of model.prices) {
      const maxCost = maxImageRequestCostMicroUsd(model, price);
      const minimum = minimumCreditsForImageOption(model, price);
      assert.ok(maxCost !== null && minimum !== null);
      assert.equal(
        maxCost,
        price.outputCostMicroUsd +
          IMAGE_PROMPT_BUDGET_MICRO_USD +
          model.priceVerification.thinkingCapMicroUsd
      );
      assert.ok(
        price.credits >= minimum,
        `${model.id} ${price.quality} ${price.size}: ${price.credits} < ${minimum}`
      );
      assert.ok(
        maxCost / price.credits <= IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD
      );
    }
  }
});

test("the registry price table agrees with the v1 flat table it replaces", () => {
  // The registry is the successor, not a second opinion: a drift here would
  // let the workspace quote one price while the reservation charges another.
  const openai = getImageModel("gpt-image-2");
  assert.equal(openai.prices.length, 9);
  assert.equal(getImageModelPrice("gpt-image-2", "low", "1024x1024").credits, 15);
  assert.equal(
    getImageModelPrice("gpt-image-2", "medium", "1536x1024").credits,
    60
  );
  assert.equal(
    getImageModelPrice("gpt-image-2", "high", "1024x1024").outputCostMicroUsd,
    211_000
  );
});

test("each model carries its own pricing version, and gpt-image-2 keeps the one already on disk", () => {
  // A reservation freezes the version of the price list it was priced by. With
  // one global string, adding xAI's price would have moved every gpt-image-2
  // reservation onto a new version without a cent of its price changing --
  // every cost report would show a boundary that corresponds to nothing.
  const versions = IMAGE_MODEL_REGISTRY.map((model) => model.pricingVersion);
  assert.equal(new Set(versions).size, versions.length);
  for (const version of versions) assert.ok(version.length > 0);

  // Not derived from IMAGE_PRICING_VERSION on purpose: coupling them would let
  // a ceiling change bump this model's version, which is the same noise in the
  // other direction. It is the literal string reservations already carry, and
  // it moves only when gpt-image-2's own prices move.
  assert.equal(getImageModel("gpt-image-2").pricingVersion, "2026-08-03-v1");
});

test("model ids are unique and every id equals its API model id today", () => {
  const ids = IMAGE_MODEL_REGISTRY.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const model of IMAGE_MODEL_REGISTRY) {
    assert.equal(model.id, model.apiModelId);
    assert.ok(model.outputMimeTypes.length > 0);
  }
});

test("sources and a verification date arrive together or not at all", () => {
  // This used to read "every model names at least one source", which held only
  // because every registered model had had its price read. A `price_unverified`
  // entry is precisely the case where it cannot: listing URLs under
  // `priceVerification.sources` says "this is what the price was checked
  // against", and writing them down before reading them says it falsely.
  //
  // So the invariant is the pairing, which is the part that was actually load
  // bearing, and it now catches the opposite error too -- sources cited with no
  // date, which reads as verified and is not.
  for (const model of IMAGE_MODEL_REGISTRY) {
    const verified = model.priceVerification.verifiedAt !== "";
    assert.equal(
      model.priceVerification.sources.length > 0,
      verified,
      `${model.id}: sources and verifiedAt disagree`
    );
    if (!verified) {
      assert.equal(
        model.disabledReason,
        "price_unverified",
        `${model.id}: no verification date, so it may not be offered or held for another reason`
      );
      assert.deepEqual(model.prices, [], `${model.id}: unverified but priced`);
    }
  }
});

test("a documented output limit is never mistaken for a proven cost cap", () => {
  // The two facts look alike and are not. `maxOutputTokens` is what the model
  // card publishes and what every request sends; `thinkingCapMicroUsd` is
  // whether the worst case is provably finite. Google publishes the first and
  // does not state the second -- the Interactions reference defines
  // max_output_tokens and reports total_output_tokens and
  // total_thought_tokens as separate counters, and nothing links them. So a
  // model may carry an output limit and still be unbounded, and writing the
  // limit in must not quietly enable anything.
  const google = IMAGE_MODEL_REGISTRY.filter(
    (model) => model.provider === "google"
  );
  assert.equal(google.length, 3);
  for (const model of google) {
    assert.ok(model.maxOutputTokens && model.maxOutputTokens > 0, model.id);
    assert.equal(model.priceVerification.thinkingCapMicroUsd, null, model.id);
    assert.equal(model.disabledReason, "worst_case_cost_unbounded", model.id);
    assert.deepEqual(model.prices, [], model.id);
  }
  // Flash Lite's low ceiling is what makes it the first model worth measuring:
  // a limit that never binds proves nothing about whether it is enforced.
  assert.equal(getImageModel("gemini-3.1-flash-lite-image").maxOutputTokens, 4_096);
});

test("no model claims a thinking level nobody verified it accepts", () => {
  // Support is per model. An unset field omits the parameter entirely, which
  // is the fail-closed direction: a request that carries a parameter the model
  // rejects fails in a way that reads like a provider outage.
  for (const model of IMAGE_MODEL_REGISTRY) {
    if (model.thinkingLevel === undefined) continue;
    assert.ok(["low", "medium", "high"].includes(model.thinkingLevel), model.id);
  }
});

test("the composer collapses the unselected models only past three enabled", () => {
  // The boundary, pinned exactly: two and three stay inline so a viewer
  // discovers the second and third model without a click -- multi-model
  // comparison is the product, and a feature nobody is shown is a feature
  // nobody uses. Four is where the model row starts outgrowing the quality,
  // size and prompt rows above it.
  assert.equal(IMAGE_INLINE_MODEL_DISCOVERY_LIMIT, 3);
  assert.equal(shouldUseCompactImageModelPicker(1), false);
  assert.equal(shouldUseCompactImageModelPicker(2), false);
  assert.equal(shouldUseCompactImageModelPicker(3), false);
  assert.equal(shouldUseCompactImageModelPicker(4), true);
  assert.equal(shouldUseCompactImageModelPicker(9), true);
});

test("the disclosure limit does not read the execution limit's environment", () => {
  // IMAGE_GROUP_MAX_MODELS bounds how much provider work one request starts
  // and is deployment-tunable; this bounds one row of UI and is a literal.
  // Deriving either from the other would let an execution decision restyle the
  // composer, or a layout decision change what a request may cost -- so the
  // decision must not move when that variable does.
  const before = shouldUseCompactImageModelPicker(3);
  process.env.IMAGE_GROUP_MAX_MODELS = "4";
  try {
    assert.equal(shouldUseCompactImageModelPicker(3), before);
    assert.equal(IMAGE_INLINE_MODEL_DISCOVERY_LIMIT, 3);
  } finally {
    delete process.env.IMAGE_GROUP_MAX_MODELS;
  }
});

test("a chip label may be shortened; the model's identity may not", () => {
  const grok = getImageModel("grok-imagine-image-quality-20260403");
  assert.equal(imageModelChipLabel(grok), "Grok Imagine");
  assert.equal(grok.name, "Grok Imagine Image Quality");
  // No short name means the full one already fits -- never an empty label.
  const openai = getImageModel("gpt-image-2");
  assert.equal(openai.shortName, undefined);
  assert.equal(imageModelChipLabel(openai), "GPT Image 2");
  for (const model of IMAGE_MODEL_REGISTRY) {
    assert.ok(imageModelChipLabel(model).length > 0, model.id);
  }
});

test("every Google model asks for the one delivery MIME its API accepts", () => {
  // Established by the API itself on 2026-08-06, which is stronger evidence
  // than the documentation this environment cannot read: it rejected
  // image/png and named image/jpeg as the supported value.
  for (const model of IMAGE_MODEL_REGISTRY) {
    if (model.provider !== "google") continue;
    assert.equal(model.deliveryMimeType, "image/jpeg", model.id);
    // The storage allowlist stays wider than the request: what may be written
    // down unmodified is a different question from what is asked for.
    assert.ok(model.outputMimeTypes.includes("image/jpeg"), model.id);
  }
});

test("what a request asks for is decided in one place, not per call site", () => {
  const google = getImageModel("gemini-3-pro-image");
  assert.equal(google.outputMimeTypes[0], "image/png");
  // The declared preference wins over the head of the storage allowlist. Two
  // call sites -- the adapter and the thinking-cap measurement script -- built
  // this expression separately, and the script kept asking for PNG after the
  // adapter had learned Google refuses it.
  assert.equal(imageDeliveryMimeType(google), "image/jpeg");
  // A model with no declared preference falls back to its allowlist, so
  // adding the field is never required to register a model.
  const openai = getImageModel("gpt-image-2");
  assert.equal(openai.deliveryMimeType, undefined);
  assert.equal(imageDeliveryMimeType(openai), openai.outputMimeTypes[0]);
  for (const model of IMAGE_MODEL_REGISTRY) {
    const delivered = imageDeliveryMimeType(model);
    assert.ok(delivered.startsWith("image/"), model.id);
    // Whatever is asked for must also be storable; otherwise a successful
    // generation would be refused on the way to R2.
    assert.ok(model.outputMimeTypes.includes(delivered), model.id);
  }
});

test("the composer layout keeps every selected model and its price inline", () => {
  // This branch cannot be reached end to end today: two models are enabled and
  // the threshold is three, so the compact rendering appears only once a
  // fourth is activated -- and enabling the three held Google models takes the
  // count from 2 straight to 5. The rule is pinned here so it is not first
  // exercised on the day it starts mattering.
  const model = (id) => ({ id, name: id, prices: [] });
  const three = [model("a"), model("b"), model("c")];
  const five = [...three, model("d"), model("e")];

  const inline = imageComposerModelLayout(three, ["b"]);
  assert.equal(inline.compact, false);
  // Below the threshold every model stays inline, selected or not: at two and
  // three a viewer discovers the others without a click, and multi-model
  // comparison is the product.
  assert.deepEqual(inline.inline.map((entry) => entry.id), ["a", "b", "c"]);
  assert.deepEqual(inline.picker, []);

  const compact = imageComposerModelLayout(five, ["b", "d"]);
  assert.equal(compact.compact, true);
  assert.deepEqual(compact.inline.map((entry) => entry.id), ["b", "d"]);
  assert.deepEqual(compact.picker.map((entry) => entry.id), ["a", "c", "e"]);
  // Every enabled model appears exactly once across the two lists -- a model
  // that fell out of both would be unreachable rather than merely collapsed.
  assert.deepEqual(
    [...compact.inline, ...compact.picker].map((entry) => entry.id).sort(),
    ["a", "b", "c", "d", "e"]
  );
});

test("selecting a model moves its container, never its position", () => {
  const model = (id) => ({ id, name: id, prices: [] });
  const five = ["a", "b", "c", "d", "e"].map(model);
  // Registry order within each list, so a chip does not jump along the row
  // when it is picked -- it changes which container it is in, and nothing else.
  const before = imageComposerModelLayout(five, ["c"]);
  assert.deepEqual(before.picker.map((entry) => entry.id), ["a", "b", "d", "e"]);
  const after = imageComposerModelLayout(five, ["c", "a"]);
  assert.deepEqual(after.inline.map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(after.picker.map((entry) => entry.id), ["b", "d", "e"]);

  // The composer never lets the selection empty, but the layout must not
  // assume it: an empty inline list is a rendering, not a crash.
  const none = imageComposerModelLayout(five, []);
  assert.deepEqual(none.inline, []);
  assert.equal(none.picker.length, 5);
});

// --- who made it vs who bills us -----------------------------------------

test("a gateway-supplied model bills its gateway, not its brand", () => {
  const model = getImageModel("fal-ai/nano-banana-2");
  assert.ok(model, "fal-ai/nano-banana-2 should be registered");

  // The two answers differ, which is the whole point of the field existing.
  assert.equal(imageModelOwner(model), "google");
  assert.equal(model.provider, "fal");

  // And money follows the provider. A fal request drawing down the Google
  // budget still adds up -- it just adds up against an envelope with no money
  // in it, while fal's own spend goes unwatched.
  const envNames = imageProviderBudgetEnvNames(model.provider);
  assert.equal(envNames.day, "IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_DAY");
  assert.equal(envNames.month, "IMAGE_PROVIDER_FAL_COST_MICROUSD_PER_MONTH");
  assert.ok(!JSON.stringify(envNames).includes("GOOGLE"));
});

test("a direct integration answers both questions the same way", () => {
  // Omitting modelOwner has to keep meaning what it meant before the field
  // existed, or adding it silently rebranded four models.
  for (const id of ["gpt-image-2", "gemini-3.1-flash-image"]) {
    const model = getImageModel(id);
    assert.equal(model.modelOwner, undefined);
    assert.equal(imageModelOwner(model), model.provider);
  }
});

test("the gateway route is enabled, and on the terms it was approved on", () => {
  const model = getImageModel("fal-ai/nano-banana-2");

  // The hold was `operational_hold` -- not `worst_case_cost_unbounded`, which
  // is the direct Google route's problem and the reason this one exists, and
  // not `price_unverified` either. What it was waiting for was an adapter, a
  // budget and a real request; all three arrived, so the reason is gone rather
  // than reworded.
  assert.equal(model.disabledReason, null);
  assert.equal(model.priceVerification.verifiedAt, "2026-08-14");
  assert.ok(model.priceVerification.sources.length > 0);

  // Unchanged by activation, and asserted here because these are the terms the
  // 120 was approved against. Enabling a row is exactly the moment a price or
  // a size could drift without anyone noticing it had.
  assert.deepEqual(model.prices, [
    { quality: "medium", size: "1024x1024", credits: 120, outputCostMicroUsd: 80_000 },
  ]);
  assert.deepEqual(model.sizes, ["1024x1024"]);
  assert.deepEqual(model.qualities, ["medium"]);

  // Enabled means dispatchable, so the provider must now be one the executor
  // budgets and concurrency layers know about.
  assert.ok(listEnabledImageModels().some((entry) => entry.id === model.id));
  assert.ok(listActiveImageProviders().includes("fal"));

  // Still Google's model bought through fal. Activation must not have quietly
  // made the gateway the owner: the watermark, the model card and the answer
  // to "whose model is this" all follow the owner, not the supplier.
  assert.equal(model.provider, "fal");
  assert.equal(model.modelOwner, "google");
  assert.deepEqual(model.provenance, ["synthid"]);
});

test("an enabled model carries no note explaining why it is disabled", () => {
  // `disabledNote` is documented as "surfaced in the admin panel for a disabled
  // model", and the panel renders it whenever it is present -- it does not
  // check the reason. So a note left behind by an activation keeps explaining a
  // hold that was lifted, on the one screen an operator would consult to find
  // out whether it had been.
  //
  // Nearly happened here: this row's note said "Held on operations... still
  // needs a fal adapter, and IMAGE_PROVIDER_FAL_COST_* budgets plus a prepaid
  // balance", all of which had been done by the time it was enabled. The
  // history moved to policy section 16.8, where it is dated.
  for (const model of listEnabledImageModels()) {
    assert.equal(
      model.disabledNote,
      undefined,
      `${model.id} is enabled but still carries a disabled note`
    );
  }
  // And the notes that remain are on models that really are held, so the field
  // is not simply going unused.
  const held = IMAGE_MODEL_REGISTRY.filter((model) => model.disabledReason !== null);
  assert.ok(held.some((model) => typeof model.disabledNote === "string"));
});

test("an enabled fal model is what arms the price drift check", () => {
  // The check is inert while the model is held -- there is no live price to
  // contradict -- and fail-closed the moment it is not. That transition is the
  // entire design, so it is asserted at the transition rather than assumed.
  const model = getImageModel("fal-ai/nano-banana-2");
  const verdict = evaluateFalPricing({ model, response: null });

  assert.equal(verdict.status, "failed");
  assert.match(verdict.problems[0], /enabled but fal's published price could not be read/);
});

test("the approved credit clears the floor its own configuration implies", () => {
  const model = getImageModel("fal-ai/nano-banana-2");
  const [price] = model.prices;

  // 80,000 image + 5,000 prompt budget + 2,000 high-thinking surcharge. The
  // prompt budget is padding rather than a fal charge -- fal bills per image,
  // not per input token -- and it stays because every other model's floor
  // carries it and a per-model exception is worth less than a consistent one.
  assert.equal(maxImageRequestCostMicroUsd(model, price), 87_000);
  assert.equal(minimumCreditsForImageOption(model, price), 97);
  assert.ok(price.credits >= 97);

  // The floor is a fact about the request, not just the price list. Omitting
  // `thinking_level` would make it 95, and a sale price justified by a 97 that
  // the adapter does not actually incur is an audit trail that disagrees with
  // the code. Policy §16.5 pins the field for that reason.
  assert.equal(model.priceVerification.thinkingCapMicroUsd, 2_000);

  // Headroom, stated so a future price move is visibly compared rather than
  // silently absorbed: 725 microUSD per credit against Grok Imagine's 733.
  const perCredit = maxImageRequestCostMicroUsd(model, price) / price.credits;
  const grok = getImageModel("grok-imagine-image-quality-20260403");
  const grokPrice = grok.prices.find((entry) => entry.size === "1024x1024");
  const grokPerCredit =
    maxImageRequestCostMicroUsd(grok, grokPrice) / grokPrice.credits;
  assert.ok(Math.abs(perCredit - grokPerCredit) < 20, `${perCredit} vs ${grokPerCredit}`);
});

test("a row's subtitle credits the model's owner, not whoever bills us", () => {
  // The bug this pins, seen on staging 2026-08-14: the catalogue row printed
  // `provider`, which is right for every direct integration because owner and
  // provider are the same string there. Nano Banana 2 is the first model where
  // they differ, and the row showed no brand at all -- the label table was
  // keyed by provider and had no `fal` entry, so it rendered `undefined` and
  // the line began with its own separator.
  //
  // Two failures in one: the wrong field, and a lookup that could miss without
  // the type noticing. This covers the field; `Record<ImageModelOwner, string>`
  // in the panel covers the lookup.
  const fal = getImageModel("fal-ai/nano-banana-2");
  assert.deepEqual(imageModelBrandParts(fal), {
    owner: "google",
    gateway: "fal",
  });

  // `docs/policy/image-generation.md` §16.1: the owner is shown and the
  // gateway is named, never hidden.
  // A row that said only "fal" would credit the wrong company for the model,
  // and one that said only "Google" would hide who the request goes to.
  assert.notEqual(imageModelBrandParts(fal).owner, fal.provider);
});

test("a direct integration says one thing, not the same thing twice", () => {
  // `gateway` is null rather than equal to the owner, so no caller can render
  // "OpenAI via OpenAI". Every model that predates the split must read exactly
  // as it did before.
  for (const model of IMAGE_MODEL_REGISTRY) {
    const brand = imageModelBrandParts(model);
    if (model.modelOwner === undefined) {
      assert.equal(brand.gateway, null, model.id);
      assert.equal(brand.owner, model.provider, model.id);
    } else {
      assert.equal(brand.owner, model.modelOwner, model.id);
    }
  }
});

test("every registered model resolves to an owner that can be labelled", () => {
  // The label table lives in the component and is typed exhaustively, so this
  // asserts the other half: that no registry entry produces an owner outside
  // the union the table is keyed by.
  const known = new Set(["openai", "google", "xai", "fal"]);
  for (const model of IMAGE_MODEL_REGISTRY) {
    const { owner, gateway } = imageModelBrandParts(model);
    assert.ok(known.has(owner), `${model.id} owner ${owner} has no brand label`);
    if (gateway !== null) {
      assert.ok(known.has(gateway), `${model.id} gateway ${gateway} has no brand label`);
    }
  }
});
