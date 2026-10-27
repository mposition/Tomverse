import assert from "node:assert/strict";
import test from "node:test";
import { mobileBillingCopy, formatMobileBillingCopy } from "../locales/mobileBilling.ts";

for (const language of ["en", "ko", "zh", "de", "fr", "es", "pt"]) {
  test(`billing copy has complete localized messages and placeholders for ${language}`, () => {
    const baseline = mobileBillingCopy("en");
    const translated = mobileBillingCopy(language);
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(baseline).sort());
    for (const [key, value] of Object.entries(translated)) {
      assert.ok(value.trim(), `${language}.${key} is empty`);
      assert.deepEqual([...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(),
        [...baseline[key].matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort(), `${language}.${key} placeholders`);
      if (language !== "en") assert.notEqual(value, baseline[key], `${language}.${key} fell back to English`);
      assert.doesNotMatch(formatMobileBillingCopy(value, { store: "Google Play", plan: "Pro", credits: "3,000", models: 3, date: "2026-11-25" }), /\{\w+\}/);
    }
    assert.match(translated.planDescription, /UTC/);
    assert.match(translated.creditReview, /support@tomverse\.app/);
    assert.match(translated.subscriptionPending, /support@tomverse\.app/);
  });
}
