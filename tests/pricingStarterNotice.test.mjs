import assert from "node:assert/strict";
import test from "node:test";

import { getPricingStarterLabelKey } from "../lib/pricingStarterNotice.ts";

test("maps a known starter id to its catalogue label", () => {
  assert.equal(
    getPricingStarterLabelKey("compare-image-models"),
    "chatStarter.cards.compareImageModels.label"
  );
});

test("returns null for absent, empty, and unknown starter ids", () => {
  assert.equal(getPricingStarterLabelKey(null), null);
  assert.equal(getPricingStarterLabelKey(""), null);
  assert.equal(getPricingStarterLabelKey("unknown-starter"), null);
});
