// What the generator is told about each registered claim: the projection
// (no evidence, no fact source) and the words a post that makes it must carry.

import assert from "node:assert/strict";
import test from "node:test";

import { MARKETING_CLAIMS } from "@/lib/marketingClaims";
import { resolveMarketingPageEvidence } from "@/lib/marketingEvidencePages";
import { generatorClaimContext } from "@/lib/marketingGeneratorContext";

const STORED = new Set(["name", "monthlyPriceCents", "currency", "maxModels"]);
const PLANS = new Map([
  ["pro", { values: { id: "pro", name: "Pro", monthlyPriceCents: 1500, annualPriceCents: 14400, currency: "USD", maxModels: 3 }, storedFields: STORED }],
  ["max", { values: { id: "max", name: "Max", monthlyPriceCents: 2500, annualPriceCents: 24000, currency: "USD", maxModels: 3 }, storedFields: STORED }],
]);

test("a page claim carries its page's sentence in each of its locales, and nothing of where it came from", () => {
  const context = generatorClaimContext(MARKETING_CLAIMS, PLANS);
  assert.equal(context.length, MARKETING_CLAIMS.length);
  for (const [index, claim] of MARKETING_CLAIMS.entries()) {
    const entry = context[index];
    assert.equal(entry.id, claim.id);
    assert.equal("evidence" in entry, false);
    assert.equal("factSource" in entry, false);
    if (claim.evidence?.kind !== "page") continue;
    assert.deepEqual(Object.keys(entry.statements).sort(), [...claim.locales].sort(), claim.id);
    for (const locale of claim.locales) {
      const page = resolveMarketingPageEvidence({ pageRoute: claim.evidence.pageRoute, localeKey: claim.evidence.localeKey, locale });
      assert.equal(entry.statements[locale], page.text, `${claim.id} ${locale}`);
    }
    assert.equal(entry.values, null);
  }
  // No route reaches the generator.
  assert.doesNotMatch(JSON.stringify(context), /"\/faq"|"\/about"|pageRoute/u);
});

test("a price claim carries exactly the stored fields its fact source names", () => {
  const context = generatorClaimContext(MARKETING_CLAIMS, PLANS);
  const pro = context.find((entry) => entry.id === "claim.pro-monthly-price");
  assert.deepEqual(pro.values, { name: "Pro", monthlyPriceCents: 1500, currency: "USD" });
  assert.deepEqual(pro.statements, {});
  // A plan the reader did not return is no values, not invented ones.
  const none = generatorClaimContext(MARKETING_CLAIMS, new Map());
  assert.equal(none.find((entry) => entry.id === "claim.pro-monthly-price").values, null);
  // Nor is a price nobody saved: the Guard refuses a compiled default, so A5 is not told it.
  const defaults = generatorClaimContext(
    MARKETING_CLAIMS,
    new Map([["pro", { values: PLANS.get("pro").values, storedFields: new Set(["name", "currency"]) }]]),
  );
  assert.equal(defaults.find((entry) => entry.id === "claim.pro-monthly-price").values, null);
});
