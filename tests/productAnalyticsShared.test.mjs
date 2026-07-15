import assert from "node:assert/strict";
import test from "node:test";
import {
  analyticsClientEventSchema,
  PRODUCT_ANALYTICS_EVENT_NAMES,
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
      credits_purchased: 3_000,
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
  assert.equal(creditPack.properties.purchase_type, "credit_pack");
  assert.equal(creditPack.properties.pack_id, "project_1500");
  assert.equal(creditPack.properties.credits_purchased, 1_500);
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
