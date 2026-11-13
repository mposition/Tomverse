import assert from "node:assert/strict";
import test from "node:test";
import { pricingMobilePlanSummaryCopy } from "../components/marketing/pricingMobilePlanSummary.ts";

test("Korean pricing page gets the phone plan summary, not only English", () => {
  assert.deepEqual(Object.keys(pricingMobilePlanSummaryCopy).sort(), ["en", "ko"]);
});

test("summary rows format monthly credits and name the plan in each language", () => {
  const en = pricingMobilePlanSummaryCopy.en;
  assert.equal(en.monthlyCredits(3000), "3,000 monthly credits");
  assert.equal(en.viewOptionsLabel("Max"), "View Max plan options");

  const ko = pricingMobilePlanSummaryCopy.ko;
  assert.equal(ko.monthlyCredits(10000), "월 10,000 크레딧");
  assert.equal(ko.viewOptionsLabel("Pro"), "Pro 플랜 옵션 보기");
  for (const value of [ko.lead, ko.label, ko.title, ko.priceNote, ko.viewOptions]) {
    assert.match(value, /[가-힣]/);
  }
});
