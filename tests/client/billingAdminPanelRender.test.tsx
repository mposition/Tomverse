import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BillingAdminPanel,
  planChangeLines,
  promotionChangeLines,
} from "@/components/admin/BillingAdminPanel";
import { AdminSaveBar } from "@/components/admin/ui/AdminSaveBar";
import { AdminSwitch } from "@/components/admin/ui/AdminSwitch";
import { adminBillingMessages } from "@/lib/adminMessages/billing";
import { adminBillingLifecycleMessages } from "@/lib/adminMessages/billingLifecycle";
import { getDefaultBillingPlans } from "@/lib/billingPlanDefaults";
import type { BillingPromotionConfig } from "@/lib/billingConfig";
import type { BillingPriceCatalog } from "@/lib/billingPriceCatalog";

const en = adminBillingMessages.en;

const row = (monthly: number, annual: number) => ({ monthly, annual });
const catalog: BillingPriceCatalog = {
  version: 1,
  plans: {
    pro: {
      AUD: row(2_000, 19_200),
      CNY: row(9_900, 95_000),
      EUR: row(1_400, 13_400),
      KRW: row(20_000, 192_000),
    },
    max: {
      AUD: row(3_900, 37_400),
      CNY: row(18_000, 172_800),
      EUR: row(2_300, 22_000),
      KRW: row(35_000, 336_000),
    },
  },
  creditPacks: {
    starter_500: { USD: 499, AUD: 700, CNY: 3_300, EUR: 450, KRW: 7_000 },
    project_1500: { USD: 999, AUD: 1_400, CNY: 6_500, EUR: 900, KRW: 14_000 },
    power_4000: { USD: 1_999, AUD: 2_800, CNY: 13_500, EUR: 1_800, KRW: 28_000 },
  },
};

const plans = getDefaultBillingPlans();
const proPlan = plans.find((plan) => plan.id === "pro")!;

const promotion = (overrides: Partial<BillingPromotionConfig> = {}): BillingPromotionConfig => ({
  id: "promo_1",
  code: "LAUNCH",
  discountPercent: 20,
  discountAmountCents: null,
  maxRedemptions: 100,
  redeemedCount: 4,
  durationMonths: 1,
  fulfillmentType: "stripe_subscription",
  accessDurationDays: null,
  appliesToPlanIds: ["pro"],
  stripeCouponId: null,
  stripePromotionCodeId: null,
  startsAt: null,
  endsAt: "2026-12-31T00:00:00.000Z",
  allowAnnualStacking: false,
  isActive: true,
  ...overrides,
});

const panel = (props: Partial<React.ComponentProps<typeof BillingAdminPanel>> = {}) =>
  renderToStaticMarkup(
    <BillingAdminPanel
      plans={plans}
      promotions={[promotion()]}
      priceCatalog={catalog}
      priceCatalogUpdatedAt="2026-11-06T22:30:00.000Z"
      priceCatalogSource="stored"
      canWrite
      subscribers={{ free: 268, pro: 31, max: 13 }}
      initialTab="plans"
      {...props}
    />
  );

test("the plans tab draws one card per plan with its subscribers and Stripe state", () => {
  const html = panel();
  for (const id of ["free", "pro", "max"]) {
    assert.match(html, new RegExp(`data-testid="billing-plan-${id}"`));
  }
  assert.match(html, /<h3[^>]*>Pro<\/h3>/);
  // Free has no payment, a paid plan without Price IDs says so, never "connected".
  assert.match(html, />No payment</);
  assert.match(html, />Price ID needed</);
  assert.doesNotMatch(html, />Stripe connected</);
  assert.match(html, />268</);
  assert.match(html, />31</);
  // Nothing is dirty yet: no save bar, and no change line.
  assert.doesNotMatch(html, /admin-save-bar/);
  assert.doesNotMatch(html, /data-changed/);
  // Stripe IDs are internal detail: closed under Technical details.
  assert.match(html, /<details class=/);
  assert.doesNotMatch(html, /<details[^>]*open/);
});

test("a subscriber count that could not be read says Unavailable, not 0", () => {
  const html = panel({ subscribers: { free: null, pro: 31, max: null } });
  assert.equal(html.match(/>Unavailable</g)?.length, 2);
});

test("the prices and promotions tabs follow initialTab, with no tab strip of their own", () => {
  const prices = panel({ initialTab: "prices" });
  assert.match(prices, /Fixed subscription prices/);
  assert.match(prices, /Last saved 2026-11-07 08:30 AEST/);
  assert.doesNotMatch(prices, /billing-plan-pro/);
  assert.match(prices, /aria-label="pro monthly AUD"/);
  assert.match(prices, /aria-label="Starter · 500 credits KRW"/);
  const promotions = panel({ initialTab: "promotions", afterPromotions: <p>risk monitor slot</p> });
  assert.match(promotions, /LAUNCH/);
  assert.match(promotions, /<input[^>]*disabled=""[^>]*data-testid="promotion-fixed-amount-input"/);
  assert.match(promotions, /risk monitor slot/);
  assert.doesNotMatch(promotions, /role="tablist"/);
});

test("a fallback price catalogue is announced, a stored one is not", () => {
  assert.match(panel({ initialTab: "prices", priceCatalogSource: "created_from_default" }), /price-catalog-fallback-notice/);
  assert.doesNotMatch(panel({ initialTab: "prices" }), /price-catalog-fallback-notice/);
});

test("a changed plan is described in one line per change, without quoting Stripe IDs", () => {
  const draft = {
    ...proPlan,
    monthlyMessageLimit: 8_000,
    allowSharing: !proPlan.allowSharing,
    stripePriceId: "price_secret_new",
  };
  const lines = planChangeLines({ ...proPlan, monthlyMessageLimit: 6_000 }, draft, en.plan);
  assert.ok(lines.includes("Monthly credits 6,000 → 8,000"));
  assert.ok(lines.some((line) => line.startsWith("Sharing ")));
  assert.ok(lines.includes("Stripe IDs"));
  assert.ok(!lines.join(" ").includes("price_secret_new"));
  assert.deepEqual(planChangeLines(proPlan, proPlan, en.plan), []);
  assert.equal(en.plan.changedNote("Monthly credits 6,000 → 8,000"), "Changed · Monthly credits 6,000 → 8,000");
  assert.equal(
    adminBillingMessages.ko.plan.changedNote("월 크레딧 6,000 → 8,000"),
    "바뀌었어요 · 월 크레딧 6,000 → 8,000"
  );
});

test("promotion edits read as added, removed or changed codes", () => {
  const stored = [promotion(), promotion({ id: "promo_2", code: "OLD" })];
  const draft = [promotion({ discountPercent: 45 }), promotion({ id: "promo_3", code: "NEW" })];
  const lines = promotionChangeLines(stored, draft, en);
  assert.deepEqual(lines, [
    "Code LAUNCH: Discount percent 20 → 45",
    "Code NEW added",
    "Code OLD removed",
  ]);
  assert.deepEqual(promotionChangeLines(stored, stored, en), []);
});

test("the save bar offers a revert and one review button, and locks without access", () => {
  const html = renderToStaticMarkup(
    <AdminSaveBar
      regionLabel={en.saveBar.region}
      title={en.saveBar.title(1)}
      detail={en.saveBar.detail}
      revertLabel={en.saveBar.revert}
      reviewLabel={en.saveBar.review}
      onRevert={() => {}}
      onReview={() => {}}
    />
  );
  assert.match(html, /role="region" aria-label="Unsaved billing changes"/);
  assert.match(html, />1 unsaved change</);
  assert.match(html, /Revert<\/button>/);
  assert.equal(html.match(/Review changes and save/g)?.length, 1);
  assert.doesNotMatch(html, /disabled=""/);

  const locked = renderToStaticMarkup(
    <AdminSaveBar
      regionLabel="r"
      title="t"
      revertLabel="Revert"
      reviewLabel="Review changes and save"
      onRevert={() => {}}
      onReview={() => {}}
      writable={false}
      requiredRole="billing:write"
    />
  );
  assert.match(locked, /<button[^>]*disabled=""[^>]*>[\s\S]*Review changes and save/);
  assert.match(locked, /Needs billing:write access/);
});

test("a switch is a checkbox with its label, and its track follows the value", () => {
  const on = renderToStaticMarkup(<AdminSwitch label="Sharing" checked onChange={() => {}} />);
  assert.match(on, /type="checkbox"[^>]*checked=""/);
  assert.match(on, /bg-emerald-500/);
  const off = renderToStaticMarkup(<AdminSwitch label="Sharing" checked={false} onChange={() => {}} />);
  assert.doesNotMatch(off, /checked=""/);
  assert.doesNotMatch(off, /bg-emerald-500/);
});

test("there is exactly one way to save: the save bar, then the review dialog", () => {
  const source = readFileSync(join(process.cwd(), "components/admin/BillingAdminPanel.tsx"), "utf8");
  // One request to the existing route, and it is the PATCH it always was.
  assert.equal(source.match(/adminFetch\("\/api\/admin\/billing", \{\s*method: "PATCH"/g)?.length, 1);
  assert.match(source, /plans: draftPlans,\s*promotions: draftPromotions,\s*priceCatalog: draftPriceCatalog,\s*priceCatalogUpdatedAt: draftPriceCatalogUpdatedAt,/);
  // `save` is reached only from the dialog's confirm; no button calls it directly.
  assert.equal(source.match(/\bsave\(\)/g)?.length, 1);
  assert.doesNotMatch(source, /onClick=\{save\}/);
  assert.doesNotMatch(source, /requestSave|showSaveReview|saveToDb/);
  assert.equal(source.match(/<AdminSaveBar/g)?.length, 1);
  assert.equal(source.match(/<AdminConfirmDialog/g)?.length, 1);
  // The review is opened from one place, which refuses while there is nothing to save.
  assert.equal(source.match(/setReviewOpen\(true\)/g)?.length, 1);
  assert.match(source, /canWrite \|\| isSaving \|\| isRefreshing \|\| dirtyCount === 0/);
  // And the panel does not paint its own tab strip or literal colours.
  assert.doesNotMatch(source, /dark:[a-z]/);
});

test("billing copy has a Korean twin in plain polite speech", () => {
  const ko = adminBillingMessages.ko;
  assert.equal(ko.saveBar.title(3), "저장하지 않은 변경 3건");
  assert.equal(ko.saveBar.revert, "되돌리기");
  assert.equal(ko.saveBar.review, "변경 내용 검토하고 저장");
  assert.equal(ko.review.summary(1, 0, 2), "플랜 변경 1건 · 시장 가격 변경 0건 · 프로모션 변경 2건");
  assert.match(adminBillingLifecycleMessages.en.paidUsersDetail(null), /could not be read/);
  assert.match(adminBillingLifecycleMessages.ko.refundQueueDetail(null, 1), /읽지 못했어요/);
});
