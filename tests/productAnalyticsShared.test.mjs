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
  ]) {
    assert.ok(PRODUCT_ANALYTICS_EVENT_NAMES.includes(eventName));
  }
});

test("analytics accepts attribution without product content", () => {
  const parsed = analyticsClientEventSchema.parse(safeEvent);
  assert.equal(parsed.utm_campaign, "launch");
  assert.equal(parsed.model_count, 3);
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
