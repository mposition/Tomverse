import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsClientEventSchema,
  ga4EcommerceEventForProductEvent,
  PRODUCT_ANALYTICS_EVENT_NAMES,
  shouldSendCustomProductEventToGa4,
} from "../lib/productAnalyticsShared.ts";

const safeEvent = {
  event_id: "d914343c-48b9-4a41-a40f-f9b8d466d7b1",
  event_name: "multi_model_compare_completed",
  occurred_at: "2026-07-13T12:00:00.000Z",
  client_id: "11b00f20-1bd3-4e18-b461-2705883fd10a",
  session_id: "1783944000000",
  utm_source: "google",
  utm_medium: "cpc",
  utm_campaign: "launch",
  language: "ko",
  country: "AU",
  model_count: 3,
  properties: {},
};

test("go-live analytics event names remain complete", () => {
  for (const eventName of [
    "landing_view",
    "cta_start_click",
    "pricing_view",
    "plan_selected",
    "chat_started",
    "first_response_completed",
    "multi_model_compare_completed",
    "comparison_review_viewed",
    "comparison_review_started",
    "comparison_review_completed",
    "comparison_review_failed",
    "followup_sent",
    "file_attached",
    "share_created",
    "signup_started",
    "signup_completed",
    "signup_page_view",
    "onboarding_shown",
    "onboarding_completed",
    "onboarding_skipped",
    "credit_limit_hit",
    "upgrade_prompt_view",
    "checkout_started",
    "checkout_failed",
    "purchase_completed",
    "return_day_1",
    "return_day_7",
    "subscription_cancelled",
    "model_finder_viewed",
    "model_finder_started",
    "model_finder_completed",
    "model_finder_skipped",
    "recommended_model_accepted",
    "recommended_model_changed",
    "advanced_model_suggested",
    "advanced_model_selected",
  ]) {
    assert.ok(PRODUCT_ANALYTICS_EVENT_NAMES.includes(eventName));
  }
});

test("model finder analytics accepts only privacy-safe experiment metadata", () => {
  const parsed = analyticsClientEventSchema.parse({
    ...safeEvent,
    event_name: "recommended_model_accepted",
    properties: {
      model_id: "gemini-2-5-flash",
      experiment_variant: "finder",
      recommendation_rank: 1,
      suggestion_reason: "document",
    },
  });
  assert.equal(parsed.properties.experiment_variant, "finder");
  assert.equal(parsed.properties.recommendation_rank, 1);
});

test("analytics accepts attribution without product content", () => {
  const parsed = analyticsClientEventSchema.parse(safeEvent);
  assert.equal(parsed.utm_campaign, "launch");
  assert.equal(parsed.model_count, 3);
});

test("analytics accepts privacy-safe locale market classification", () => {
  const parsed = analyticsClientEventSchema.parse({
    ...safeEvent,
    properties: {
      market_tier: "primary",
      paid_marketing_eligible: true,
    },
  });
  assert.equal(parsed.properties.market_tier, "primary");
  assert.equal(parsed.properties.paid_marketing_eligible, true);
});

test("purchase analytics distinguishes subscriptions from credit packs", () => {
  const subscription = analyticsClientEventSchema.parse({
    ...safeEvent,
    event_name: "checkout_started",
    properties: {
      purchase_type: "subscription",
      product_id: "subscription_pro_monthly",
      monthly_credits_included: 3_000,
      current_plan: "free",
      trigger: "proactive",
      plan_credits_remaining: 120,
      addon_credits_remaining: 40,
    },
  });
  const creditPack = analyticsClientEventSchema.parse({
    ...safeEvent,
    event_name: "purchase_completed",
    properties: {
      purchase_type: "credit_pack",
      product_id: "project_1500",
      pack_id: "project_1500",
      credits_purchased: 1_500,
      current_plan: "pro",
      trigger: "usage_widget",
      plan_credits_remaining: 80,
      addon_credits_remaining: 20,
    },
  });

  assert.equal(subscription.properties.purchase_type, "subscription");
  assert.equal(subscription.properties.product_id, "subscription_pro_monthly");
  assert.equal(subscription.properties.monthly_credits_included, 3_000);
  assert.equal(subscription.properties.credits_purchased, undefined);
  assert.equal(creditPack.properties.purchase_type, "credit_pack");
  assert.equal(creditPack.properties.product_id, "project_1500");
  assert.equal(creditPack.properties.pack_id, "project_1500");
  assert.equal(creditPack.properties.credits_purchased, 1_500);
  assert.equal(creditPack.properties.monthly_credits_included, undefined);
});

test("GA4 ecommerce mapping emits begin_checkout with a single product item", () => {
  const event = ga4EcommerceEventForProductEvent("checkout_started", {
    billing_interval: "annual",
    plan_id: "pro",
    purchase_type: "subscription",
    product_id: "subscription_pro_annual",
    monthly_credits_included: 3_000,
    current_plan: "free",
    trigger: "proactive",
    value: 144,
    currency: "USD",
  });

  assert.equal(event?.name, "begin_checkout");
  assert.equal(event?.params.value, 144);
  assert.equal(event?.params.currency, "USD");
  assert.equal(event?.params.transaction_id, undefined);
  assert.deepEqual(event?.params.items, [
    {
      item_id: "subscription_pro_annual",
      item_name: "Tomverse Pro annual",
      affiliation: "Tomverse",
      item_brand: "Tomverse",
      item_category: "Subscription",
      item_variant: "annual",
      price: 144,
      quantity: 1,
    },
  ]);
});

test("GA4 ecommerce mapping emits purchase with Stripe transaction id", () => {
  const event = ga4EcommerceEventForProductEvent("purchase_completed", {
    plan_id: "pro",
    purchase_type: "credit_pack",
    product_id: "project_1500",
    pack_id: "project_1500",
    credits_purchased: 1_500,
    current_plan: "pro",
    trigger: "usage_widget",
    value: 9.99,
    currency: "USD",
    transaction_id: "cs_test_123",
  });

  assert.equal(event?.name, "purchase");
  assert.equal(event?.params.transaction_id, "cs_test_123");
  assert.equal(event?.params.items[0].item_id, "project_1500");
  assert.equal(event?.params.items[0].item_category, "Credit pack");
  assert.equal(event?.params.items[0].price, 9.99);
  assert.equal(event?.params.credits_purchased, 1_500);
});

test("GA4 purchase mapping requires complete revenue fields", () => {
  assert.equal(
    ga4EcommerceEventForProductEvent("purchase_completed", {
      purchase_type: "subscription",
      product_id: "subscription_pro_monthly",
      value: 15,
      currency: "USD",
    }),
    null
  );
});

test("purchase_completed stays in the Tomverse ledger and is not sent as a custom GA4 event", () => {
  assert.equal(shouldSendCustomProductEventToGa4("purchase_completed"), false);
  assert.equal(shouldSendCustomProductEventToGa4("checkout_started"), true);
});

test("purchase analytics rejects ambiguous credit quantity fields", () => {
  assert.equal(
    analyticsClientEventSchema.safeParse({
      ...safeEvent,
      event_name: "checkout_started",
      properties: {
        purchase_type: "subscription",
        product_id: "subscription_pro_annual",
        credits_purchased: 36_000,
      },
    }).success,
    false
  );
  assert.equal(
    analyticsClientEventSchema.safeParse({
      ...safeEvent,
      event_name: "checkout_started",
      properties: {
        purchase_type: "credit_pack",
        product_id: "project_1500",
        pack_id: "project_1500",
        monthly_credits_included: 1_500,
      },
    }).success,
    false
  );
});

test("purchase analytics rejects unsupported triggers", () => {
  assert.equal(
    analyticsClientEventSchema.safeParse({
      ...safeEvent,
      event_name: "checkout_started",
      properties: {
        purchase_type: "subscription",
        trigger: "unknown_surface",
      },
    }).success,
    false
  );
});

test("analytics rejects prompts, responses, and file metadata", () => {
  for (const forbiddenProperty of ["prompt", "response", "file_name", "file_content"]) {
    assert.equal(
      analyticsClientEventSchema.safeParse({
        ...safeEvent,
        properties: { [forbiddenProperty]: "private data" },
      }).success,
      false
    );
  }
});

test("analytics rejects unknown top-level fields", () => {
  assert.equal(
    analyticsClientEventSchema.safeParse({
      ...safeEvent,
      email: "person@example.com",
    }).success,
    false
  );
});
