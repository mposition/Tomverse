import assert from "node:assert/strict";
import test from "node:test";

import { en } from "../locales/en.ts";
import { ko } from "../locales/ko.ts";
import { zh } from "../locales/zh.ts";
import { zhHant } from "../locales/zhHant.ts";
import { fr } from "../locales/fr.ts";
import { de } from "../locales/de.ts";
import { es } from "../locales/es.ts";
import { pt } from "../locales/pt.ts";
import { getPricingStarterLabelKey } from "../lib/pricingStarterNotice.ts";

test("maps a known starter id to its catalogue label", () => {
  assert.equal(
    getPricingStarterLabelKey("compare-image-models"),
    "chatStarter.cards.compareImageModels.label"
  );
});

test("the starter label key resolves to translated copy in every language", () => {
  const dictionaries = [en, ko, zh, zhHant, fr, de, es, pt];
  const key = getPricingStarterLabelKey("compare-image-models");
  assert.ok(key);

  for (const dictionary of dictionaries) {
    const value = key.split(".").reduce((current, part) => current?.[part], dictionary);
    assert.equal(typeof value, "string");
    assert.ok(value.trim().length > 0);
    assert.notEqual(value, key);
  }
});

test("returns null for absent, empty, and unknown starter ids", () => {
  assert.equal(getPricingStarterLabelKey(null), null);
  assert.equal(getPricingStarterLabelKey(""), null);
  assert.equal(getPricingStarterLabelKey("unknown-starter"), null);
});
