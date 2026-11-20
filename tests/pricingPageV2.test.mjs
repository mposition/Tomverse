import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { INPUT_CREDIT_MULTIPLIERS, MODEL_USAGE_CREDIT_WEIGHTS } from "../lib/models.ts";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "../lib/webSearchCredits.ts";
import { pricingPageContent } from "../components/marketing/v2/pricing/pricingPageContent.ts";
import { CALCULATOR_BANDS, calculateSend, requestsPerMonth } from "../components/marketing/v2/pricing/creditCalculatorMath.ts";

// The V2 pricing page (/pricing). Korean is the approved wording; every other locale keeps
// its shape and its placeholders. The page states no price, credit figure or pack of its own,
// and the purchase flow it renders is the previous page's, unchanged.
const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const tokens = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => tokens(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{\w+\}/g)].map((match) => `${path}:${match[0]}`).sort() : [];
const source = (file) => readFileSync(new URL(`../components/marketing/v2/pricing/${file}`, import.meta.url), "utf8");

test("pricing page copy is complete in every language and keeps its placeholders", () => {
  const ko = pricingPageContent.ko;
  assert.deepEqual(Object.keys(pricingPageContent).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    const copy = pricingPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: pricing page copy shape differs from Korean`);
    assert.deepEqual(tokens(copy), tokens(ko), `${locale}: placeholders differ from Korean`);
    assert.equal(copy.plans.ticks.free.length, 4, locale);
    assert.ok(copy.faq.items.some((item) => item.promotionOnly), `${locale}: promotion FAQ missing`);
  }
});

test("pricing page copy states no price, credit figure or discount of its own", () => {
  for (const locale of SEO_LOCALES) {
    const copy = pricingPageContent[locale];
    const text = JSON.stringify(copy);
    // Plan allowances, the discount and the input ceiling are data, never literals in the copy.
    assert.doesNotMatch(text, /\b(?:3[.,\s]?000|10[.,\s]?000|1[.,\s]?500|4[.,\s]?000)\b/, `${locale}: a credit figure is written into the copy`);
    assert.doesNotMatch(text, /[$₩€]\s?\d|\d\s?(?:USD|AUD|KRW)\b/, `${locale}: a price is written into the copy`);
    assert.doesNotMatch(text, /\b50\s?%/, `${locale}: the promotion discount is written into the copy`);
    assert.doesNotMatch(text, /128[,.\s]?000/, `${locale}: the long-context threshold is written into the copy`);
    assert.match(copy.calc.longContextNote, /\{tokens\}/, locale);
    assert.match(copy.plans.ticks.free[1], /\{premium\}/, `${locale}: Free's higher-cost model limit is not a placeholder`);
    assert.match(copy.points.note, /\{daily\}/, locale);
    assert.match(copy.points.note, /\{premium\}/, locale);
  }
  assert.match(pricingPageContent.ko.hero.body, /\{standard\}/);
});

test("pricing page copy claims no estimate before sending, and names Korean products like the menu", () => {
  const ko = JSON.stringify(pricingPageContent.ko);
  assert.doesNotMatch(ko, /예상 크레딧|(?:보내기|전송) 전[^.]*예상|확인 후 채택/);
  // The reservation note ("the most it can use is held before sending") is not an estimate shown to the visitor.
  assert.doesNotMatch(JSON.stringify(pricingPageContent.en), /estimated credits|estimates? (?:shown )?before/i);
  assert.doesNotMatch(ko, /\bChat\b|\bReview\b/);
  assert.match(ko, /답변 비교/);
  assert.match(pricingPageContent.ko.hero.primary, /^무료로/);
});

test("Free's limits are stated from data and the contract's wording", () => {
  const ko = pricingPageContent.ko;
  // 하루 {daily} 한도 and 월 {premium}회 are filled from the billing config and from the
  // CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH default (lib/chatSecurity.ts).
  assert.match(ko.points.note, /하루 \{daily\} 한도/);
  assert.match(ko.points.note, /월 \{premium\}회/);
  assert.match(ko.plans.lockedNote, /Pro 이상 전용 모델은 쓸 수 없습니다/);
  const page = source("PricingPage.tsx");
  assert.match(page, /FREE_HIGHER_COST_RESPONSES_PER_MONTH = 30/);
  assert.match(readFileSync(new URL("../lib/chatSecurity.ts", import.meta.url), "utf8"), /CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH,\s*30/);
  assert.match(page, /limits\[id\]\.dailyCredits === 0/);
  assert.match(page, /billing\.planLimits\(id\)/);
});

test("the calculator charges what a send is charged", () => {
  assert.deepEqual(CALCULATOR_BANDS.map((band) => band.multiplier), [1, ...INPUT_CREDIT_MULTIPLIERS.map((band) => band.multiplier)]);
  assert.deepEqual(CALCULATOR_BANDS.map((band) => band.multiplier), [1, 1.5, 2, 3]);
  assert.deepEqual([MODEL_USAGE_CREDIT_WEIGHTS.standard, MODEL_USAGE_CREDIT_WEIGHTS.advanced, MODEL_USAGE_CREDIT_WEIGHTS.premium], [1, 4, 8]);
  assert.equal(WEB_SEARCH_SURCHARGE_CREDITS, 8);
  assert.equal(calculateSend(["standard"], 0, false).perSend, 1);
  assert.equal(calculateSend(["standard", "advanced", "premium"], 0, false).perSend, 13);
  // Each model is rounded up on its own: 2 + 6 + 12, not ceil(13 * 1.5).
  assert.equal(calculateSend(["standard", "advanced", "premium"], 1, false).perSend, 20);
  assert.equal(calculateSend(["standard", "advanced", "premium"], 3, false).perSend, 39);
  // The search surcharge is per model and never multiplied by the input length.
  assert.equal(calculateSend(["standard"], 3, true).searchCredits, 8);
  assert.equal(calculateSend(["standard", "premium"], 2, true).searchCredits, 16);
  assert.equal(calculateSend(["standard", "premium"], 2, true).perSend, 2 + 16 + 16);
  assert.equal(requestsPerMonth(300, 13), 23);
  assert.equal(requestsPerMonth(300, 0), 0);
});

test("the purchase flow is the previous page's, with its events and entry points", () => {
  const flow = source("usePricingPurchaseFlow.ts");
  const page = source("PricingPage.tsx");
  for (const event of ["pricing_view", "checkout_cancelled", "purchase_intent_resumed", "credit_pack_cta_view", "credit_pack_cta_click"]) {
    assert.ok(flow.includes(`"${event}"`), event);
  }
  assert.ok(flow.includes('trackProductEvent("pricing_view")'));
  for (const event of ["plan_selected", "authentication_required"]) assert.ok(page.includes(`"${event}"`), event);
  for (const name of ["UpgradeInterestButton", "PlanChangeDialog", "CreditPackPurchaseButton", "resolvePlanCtaState", "shouldHideFreePlanCta", "buildPlanChangeSupportHref"]) {
    assert.ok(page.includes(name), name);
  }
  // Checkout and plan buttons are the existing components; the page builds none of its own.
  assert.doesNotMatch(page, /fetch\(|\/api\/billing\/checkout/);
  assert.ok(page.includes("featuredPromotion.code"));
  assert.match(page, /initialBillingInterval=\{lang === "ko" \? subscriptionInterval : undefined\}/);
  // Same plan buttons for the same states as before.
  for (const state of ["loading", "current_plan", "change_plan", "manage_plan", "signed_out"]) assert.ok(page.includes(`"${state}"`), state);
});

test("the long-context note appears only while it is configured", () => {
  const page = source("PricingPage.tsx");
  assert.match(page, /billing\.config\?\.appLongContext === true && billing\.config\.appInputTokenLimit\s*\?\s*fill\(copy\.calc\.longContextNote/);
});

test("the models dialog is a modal dialog element", () => {
  const dialog = source("PlanModelsDialog.tsx");
  assert.match(dialog, /<dialog /);
  assert.match(dialog, /showModal\(\)/);
  assert.match(dialog, /aria-labelledby="pd-title"/);
  assert.match(dialog, /onClose=\{onClose\}/);
  // No inline script and no innerHTML anywhere on the page.
  for (const file of ["PricingPage.tsx", "PlanModelsDialog.tsx", "CreditCalculator.tsx", "usePricingPurchaseFlow.ts"]) {
    assert.doesNotMatch(source(file), /dangerouslySetInnerHTML|innerHTML|<script/, file);
  }
});

// The stylesheet is a global CSS file imported by PricingPage, so its only isolation is the
// .tv-page scope (same checks as tests/chatProductPageV2.test.mjs).
const css = readFileSync(new URL("../components/marketing/v2/pricing/pricing-page.css", import.meta.url), "utf8");
const root = postcss.parse(css);

test("every pricing page rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("pricing page keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvp2-/, at.params));
});

test("pricing page text stays at or above the 11px floor and uses the locale font variables", () => {
  const small = [];
  root.walkDecls(/^font(-size)?$/, (decl) => {
    for (const [, value, unit] of decl.value.matchAll(/(?:^|[\s/(,])(\d*\.?\d+)(rem|px)\b/g)) {
      const px = Number(value) * (unit === "rem" ? 16 : 1);
      if (px > 0 && px < 11) small.push(`${decl.parent.selector} { ${decl.prop}: ${decl.value} }`);
    }
  });
  assert.deepEqual(small, []);
  assert.doesNotMatch(css, /font-family:\s*["']?Geist/);
});

test("pricing page can be paused from the page root and keeps reduced motion", () => {
  assert.match(css, /\.tv-page\[data-motion="paused"\]/);
  assert.match(source("PricingPage.tsx"), /prefers-reduced-motion: reduce/);
});
