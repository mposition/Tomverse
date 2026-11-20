import assert from "node:assert/strict";
import test from "node:test";
import { pricingPageContent } from "../components/marketing/v2/pricing/pricingPageContent.ts";

test("Korean Max card names Premium as a model tier, not an unexplained plan", () => {
  const maxTicks = pricingPageContent.ko.plans.ticks.max;
  assert.equal(pricingPageContent.ko.plans.cta[2], "Max로 업그레이드");
  assert.ok(maxTicks.length > 0, "ko Max plan is present");
  for (const tick of maxTicks) assert.doesNotMatch(tick, /Premium 사용량/);
  assert.ok(
    maxTicks.some((tick) => /Premium 등급 모델 사용에는 월 크레딧 및 공정 사용 정책 적용/.test(tick)),
    "the Max card says Premium is a model category under the monthly credits and fair use policy",
  );
});
