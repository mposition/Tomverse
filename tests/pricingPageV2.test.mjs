import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { INPUT_CREDIT_MULTIPLIERS, MODEL_USAGE_CREDIT_WEIGHTS } from "../lib/models.ts";
import { WEB_SEARCH_SURCHARGE_CREDITS } from "../lib/webSearchCredits.ts";
import { pricingPageContent } from "../components/marketing/v2/pricing/pricingPageContent.ts";
import { CALCULATOR_BANDS, calculateSend, requestsPerMonth } from "../components/marketing/v2/pricing/creditCalculatorMath.ts";
import {
  annualDiscountPercent,
  commonDiscountPercent,
  joinPlanNames,
  promotionAppliesToPlan,
  promotionPeriodPhrase,
  promotionPlanNames,
} from "../components/marketing/v2/pricing/pricingPromotion.ts";

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
    // The annual saving, the Free higher-cost response limit and the promotion's length and
    // targets are not in the copy as numbers or plan names: the first two are data, the limit
    // is an env value the public billing response does not carry.
    assert.doesNotMatch(text, /\{premium\}/, `${locale}: a response count placeholder is left in the copy`);
    assert.doesNotMatch(text, /\b20\s?%/, `${locale}: the annual saving is written into the copy`);
    for (const sentence of [copy.plans.ticks.free[1], copy.points.note, copy.models.notes[0]]) {
      assert.equal(/\b30\b/.test(sentence), false, `${locale}: a response limit is written into: ${sentence}`);
    }
    assert.match(copy.plans.save, /\{percent\}/, locale);
    for (const sentence of [copy.plans.sale.duration, copy.plans.promo.billingNote, copy.faq.items.find((item) => item.promotionOnly).answer]) {
      assert.match(sentence, /\{period\}/, `${locale}: ${sentence}`);
    }
    for (const sentence of [copy.plans.promo.billingNote, copy.plans.promo.eligibility, copy.faq.items.find((item) => item.promotionOnly).answer]) {
      assert.match(sentence, /\{plans\}/, `${locale}: ${sentence}`);
      assert.doesNotMatch(sentence, /\bPro\b.*\bMax\b/, `${locale}: the promotion's plans are written into: ${sentence}`);
    }
    assert.match(copy.plans.promo.period.months, /\{n\}/, locale);
    assert.doesNotMatch(copy.plans.promo.period.first, /\{/, locale);
    assert.match(copy.points.note, /\{daily\}/, locale);
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
  // 하루 {daily} 한도 comes from the billing config. The monthly higher-cost response count is
  // CHAT_FREE_PRO_MODEL_RESPONSES_PER_MONTH, which the public billing response does not carry,
  // so the page says there is a limit and writes no number.
  assert.match(ko.points.note, /하루 \{daily\} 한도/);
  assert.match(ko.points.note, /고비용 모델은 월 사용 횟수 한도가 있습니다/);
  assert.match(ko.plans.ticks.free[1], /월 사용 횟수 한도/);
  assert.match(ko.plans.lockedNote, /Pro 이상 전용 모델은 쓸 수 없습니다/);
  const page = source("PricingPage.tsx");
  assert.doesNotMatch(page, /FREE_HIGHER_COST|premiumCount|premiumLimit/);
  assert.doesNotMatch(source("PlanModelsDialog.tsx"), /premium/);
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

test("the breakdown keeps the base cost apart from the total after the length multiplier", () => {
  // One Standard model at 1.5x: the base cost is 1 credit and the total is 2, not "2 x 1.5".
  const send = calculateSend(["standard"], 1, false);
  assert.equal(CALCULATOR_BANDS[1].multiplier, 1.5);
  assert.deepEqual([send.base, send.models, send.perSend], [1, 2, 2]);
  // Three tiers at 1.5x: base 13, total 2 + 6 + 12 after rounding each model up.
  const all = calculateSend(["standard", "advanced", "premium"], 1, false);
  assert.deepEqual([all.base, all.models], [13, 20]);
  // The base ignores the web search surcharge; the total includes it.
  const web = calculateSend(["standard"], 1, true);
  assert.deepEqual([web.base, web.models, web.perSend], [1, 2, 10]);
  // Every language shows the base, the multiplier and the total.
  for (const locale of SEO_LOCALES) {
    const { breakdown } = pricingPageContent[locale].calc;
    for (const token of ["{base}", "{mult}", "{models}"]) assert.ok(breakdown.includes(token), `${locale}: ${token}`);
    assert.ok(breakdown.indexOf("{base}") < breakdown.indexOf("{mult}") && breakdown.indexOf("{mult}") < breakdown.indexOf("{models}"), locale);
  }
  assert.match(source("CreditCalculator.tsx"), /base: numberFormat\.format\(base\)/);
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

test("the annual saving is worked out from the plan's own prices", () => {
  // 20% on the built-in plans: 12 x 15 = 180 against 144, and 12 x 25 = 300 against 240.
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 14400 }), 20);
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 2500, annualPriceCents: 24000 }), 20);
  // The market price the visitor sees wins: A$20 a month against A$192 a year.
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 14400, displayMonthlyPriceAmount: 20, displayAnnualPriceAmount: 192 }), 20);
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 14400, displayMonthlyPriceAmount: 20, displayAnnualPriceAmount: 180 }), 25);
  // A whole percent, rounded: 1 - 215 / 240 = 10.4%.
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 2000, annualPriceCents: 21500 }), 10);
  // A half-known display price falls back to the base prices of one currency.
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 14400, displayAnnualPriceAmount: 999 }), 20);
});

test("no annual saving is shown when there is none, or the prices are unknown", () => {
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 18000 }), null, "a year at twelve months is no saving");
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 19000 }), null, "a dearer year is no saving");
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 0, annualPriceCents: 0 }), null, "Free has no annual price");
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: Number.NaN }), null);
  assert.equal(annualDiscountPercent({ monthlyPriceCents: 1500, annualPriceCents: 17950 }), null, "under half a percent rounds to none");
  assert.equal(annualDiscountPercent(null), null);
  assert.equal(annualDiscountPercent(undefined), null);
  // The cycle selector names one saving only when every paid plan has the same.
  assert.equal(commonDiscountPercent([20, 20]), 20);
  assert.equal(commonDiscountPercent([20, 25]), null);
  assert.equal(commonDiscountPercent([20, null]), null);
  assert.equal(commonDiscountPercent([]), null);
  // The page uses these results and renders the chip only for a number.
  const page = source("PricingPage.tsx");
  assert.match(page, /planSave \? <span className="chip blue">\{planSave\}<\/span> : null/);
  assert.match(page, /selectorSave \? <span className="chip blue">\{selectorSave\}<\/span> : null/);
});

test("the promotion's length and plans come from the promotion", () => {
  const period = pricingPageContent.ko.plans.promo.period;
  assert.equal(promotionPeriodPhrase(period, 1), "첫 달");
  assert.equal(promotionPeriodPhrase(period, 3), "처음 3개월");
  assert.equal(promotionPeriodPhrase(pricingPageContent.en.plans.promo.period, 1), "the first month");
  assert.equal(promotionPeriodPhrase(pricingPageContent.en.plans.promo.period, 3), "the first 3 months");
  assert.equal(promotionPeriodPhrase(pricingPageContent.de.plans.promo.period, 12), "in den ersten 12 Monaten");
  assert.deepEqual(promotionPlanNames({ appliesToPlanIds: ["pro", "max"] }), ["Pro", "Max"]);
  assert.deepEqual(promotionPlanNames({ appliesToPlanIds: ["max", "pro"] }), ["Pro", "Max"], "plan order, not list order");
  assert.deepEqual(promotionPlanNames({ appliesToPlanIds: ["pro"] }), ["Pro"]);
  assert.deepEqual(promotionPlanNames({ appliesToPlanIds: ["free"] }), [], "Free is not a paid plan");
  assert.equal(joinPlanNames(["Pro", "Max"], "또는"), "Pro 또는 Max");
  assert.equal(joinPlanNames(["Pro"], "or"), "Pro");
  // Filled into the copy: a three-month Pro-only promotion says exactly that.
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => (key in values ? values[key] : match));
  const values = { percent: "50", period: promotionPeriodPhrase(period, 3), plans: "Pro" };
  assert.equal(fill(pricingPageContent.ko.plans.sale.duration, values), "처음 3개월 적용");
  assert.equal(fill(pricingPageContent.ko.plans.promo.billingNote, values), "출시 특가: Pro 처음 3개월 50% 할인. 언제든 취소할 수 있습니다.");
  assert.equal(fill(pricingPageContent.ko.plans.promo.eligibility, values), "월간 Pro · 계정당 1회");
  const en = { percent: "50", period: "the first 3 months", plans: joinPlanNames(["Pro", "Max"], "or") };
  assert.equal(fill(pricingPageContent.en.plans.sale.duration, en), "for the first 3 months");
  assert.match(fill(pricingPageContent.en.faq.items.find((item) => item.promotionOnly).answer, en), /50% off Pro or Max for the first 3 months/);
});

test("the promotion's discount shows only on the plans it applies to", () => {
  const promotion = { appliesToPlanIds: ["pro"], billingIntervals: ["monthly"] };
  assert.equal(promotionAppliesToPlan(promotion, "pro"), true);
  assert.equal(promotionAppliesToPlan(promotion, "max"), false, "a Pro-only promotion leaves the Max card without a discount");
  assert.equal(promotionAppliesToPlan(promotion, "free"), false);
  assert.equal(promotionAppliesToPlan({ appliesToPlanIds: ["pro", "max"], billingIntervals: ["annual"] }, "pro"), false, "only a monthly discount is shown on the monthly price");
  assert.equal(promotionAppliesToPlan(null, "pro"), false);
  // The card and the banner read the same data; the page keeps no plan list or duration of its own.
  const page = source("PricingPage.tsx");
  assert.match(page, /promotionAppliesToPlan\(featuredPromotion, planId\)/);
  assert.match(page, /featuredPromotion\.durationMonths/);
  assert.match(page, /promotionPlanNames\(featuredPromotion\)/);
  assert.doesNotMatch(page, /첫 달|Pro or Max|Pro 또는 Max/);
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
