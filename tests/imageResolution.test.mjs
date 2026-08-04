import assert from "node:assert/strict";
import test from "node:test";
import {
  googleRequestForOption,
  legacyImageSizeForOption,
  openAiSizeForOption,
  optionForLegacyImageSize,
  SELLABLE_IMAGE_OPTIONS,
  xaiRequestForOption,
} from "../lib/imageResolution.ts";

// The two-axis size model. These tests exist because the failure they guard
// against is silent: a size that maps to "the nearest thing" charges one
// image's approved price for a different image, and nobody sees it until the
// provider invoice does.

test("every legacy size reads back as an option, with no fallback", () => {
  // Total over ImageSize on purpose. Every row ever stored carries one of
  // these three strings, so a lookup that could miss would turn history into
  // unknown data.
  assert.deepEqual(optionForLegacyImageSize("1024x1024"), {
    tier: "1k",
    aspectRatio: "1:1",
  });
  assert.deepEqual(optionForLegacyImageSize("1536x1024"), {
    tier: "1k",
    aspectRatio: "3:2",
  });
  assert.deepEqual(optionForLegacyImageSize("1024x1536"), {
    tier: "1k",
    aspectRatio: "2:3",
  });
});

test("the mapping round-trips for everything the catalogue sells", () => {
  for (const option of SELLABLE_IMAGE_OPTIONS) {
    const size = legacyImageSizeForOption(option);
    assert.ok(size, `${option.tier} ${option.aspectRatio} has no legacy size`);
    assert.deepEqual(optionForLegacyImageSize(size), option);
  }
});

test("an option the catalogue cannot price has no legacy size at all", () => {
  // This is the point of the null rather than a gap in the table: 2K ships
  // with its own storage and pricing representation, never squeezed into a
  // pixel pair that already means 1K.
  for (const tier of ["0.5k", "2k", "4k"]) {
    for (const aspectRatio of ["1:1", "3:2", "2:3"]) {
      assert.equal(
        legacyImageSizeForOption({ tier, aspectRatio }),
        null,
        `${tier} ${aspectRatio}`
      );
    }
  }
});

test("OpenAI gets the pixel pair; xAI and Google get named tiers", () => {
  const square = { tier: "1k", aspectRatio: "1:1" };
  assert.equal(openAiSizeForOption(square), "1024x1024");
  assert.deepEqual(xaiRequestForOption(square), {
    resolution: "1k",
    aspectRatio: "1:1",
  });
  assert.deepEqual(googleRequestForOption(square), {
    imageSize: "1K",
    aspectRatio: "1:1",
  });
});

test("xAI is offered only the tiers it documents", () => {
  // 0.5K and 4K are Google tiers. Sending one to xAI would either error or,
  // worse, be silently served at a price nobody recorded.
  assert.equal(xaiRequestForOption({ tier: "0.5k", aspectRatio: "1:1" }), null);
  assert.equal(xaiRequestForOption({ tier: "4k", aspectRatio: "1:1" }), null);
  assert.deepEqual(xaiRequestForOption({ tier: "2k", aspectRatio: "1:1" }), {
    resolution: "2k",
    aspectRatio: "1:1",
  });
});

test("OpenAI refuses a tier it has no pixel pair for", () => {
  assert.equal(openAiSizeForOption({ tier: "2k", aspectRatio: "1:1" }), null);
  assert.equal(openAiSizeForOption({ tier: "4k", aspectRatio: "2:3" }), null);
});

test("the sellable set is exactly what the price table covers", () => {
  // A fourth entry here without a price is an option that cannot be charged
  // for; the price table and this list move together or not at all.
  assert.equal(SELLABLE_IMAGE_OPTIONS.length, 3);
  assert.ok(SELLABLE_IMAGE_OPTIONS.every((option) => option.tier === "1k"));
});
