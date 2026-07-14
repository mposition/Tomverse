import assert from "node:assert/strict";
import test from "node:test";
import {
  PAID_MARKETING_LOCALES,
  localeLaunchPolicy,
  localeMarketingAnalyticsProperties,
} from "../lib/localeLaunchPolicy.ts";

test("paid launch languages are limited to complete primary markets", () => {
  assert.deepEqual(PAID_MARKETING_LOCALES, ["en", "ko"]);
  assert.equal(localeLaunchPolicy.en.marketTier, "primary");
  assert.equal(localeLaunchPolicy.ko.marketTier, "primary");
  assert.equal(localeLaunchPolicy.en.paidMarketingEligible, true);
  assert.equal(localeLaunchPolicy.ko.paidMarketingEligible, true);
});

test("Chinese is limited and remaining launch languages are preview-only", () => {
  assert.equal(localeLaunchPolicy.zh.marketTier, "limited");
  for (const language of ["zh", "fr", "de", "es", "pt"]) {
    assert.equal(localeLaunchPolicy[language].paidMarketingEligible, false);
    assert.ok(localeLaunchPolicy[language].scopeNotice.length > 40);
    assert.ok(localeLaunchPolicy[language].englishFallbackNotice.length > 40);
  }
  for (const language of ["fr", "de", "es", "pt"]) {
    assert.equal(localeLaunchPolicy[language].marketTier, "preview");
  }
});

test("analytics market properties are derived from the locale policy", () => {
  assert.deepEqual(localeMarketingAnalyticsProperties("ko"), {
    market_tier: "primary",
    paid_marketing_eligible: true,
  });
  assert.deepEqual(localeMarketingAnalyticsProperties("fr"), {
    market_tier: "preview",
    paid_marketing_eligible: false,
  });
});
