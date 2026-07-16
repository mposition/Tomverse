import { expect, test } from "@playwright/test";
import {
  mockChatStream,
  prepareGuestPage,
} from "./support/app-fixtures";

type CapturedAnalyticsEvent = {
  event_name: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  properties: Record<string, unknown>;
};

const billingPlan = (
  id: "free" | "pro" | "max",
  monthlyPriceCents: number,
  annualPriceCents: number
) => ({
  id,
  name: id === "free" ? "Free" : id === "pro" ? "Pro" : "Max",
  monthlyPriceCents,
  annualPriceCents,
  currency: "USD",
  baseCurrency: "USD",
  baseMonthlyPriceCents: monthlyPriceCents,
  baseAnnualPriceCents: annualPriceCents,
  monthlyMessageLimit: id === "free" ? 300 : id === "pro" ? 3_000 : 10_000,
});

test("test campaign retains first-touch UTM through consent, chat, signup, and checkout", async ({
  page,
}) => {
  const capturedEvents: CapturedAnalyticsEvent[] = [];
  let checkoutRequest: Record<string, unknown> | null = null;
  await page.context().addCookies([
    {
      name: "__tomverse_e2e_analytics",
      value: "1",
      url: "http://127.0.0.1:3100",
    },
  ]);
  await prepareGuestPage(page, "en");
  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_guest_quick_start_seen_v2", "1");
  });
  await mockChatStream(page, "Campaign QA response");

  await page.route("**/api/analytics/events", async (route) => {
    capturedEvents.push(
      route.request().postDataJSON() as CapturedAnalyticsEvent
    );
    await route.fulfill({ status: 202, body: "" });
  });
  await page.route("**/api/billing/config**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        plans: [
          billingPlan("free", 0, 0),
          billingPlan("pro", 1_500, 14_400),
          billingPlan("max", 2_500, 24_000),
        ],
        featuredPromotion: null,
      }),
    })
  );
  await page.route("**/api/billing/checkout", (route) => {
    checkoutRequest = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "http://127.0.0.1:3100/__qa_checkout__" }),
    });
  });
  await page.route("**/__qa_checkout__", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>QA checkout</title>",
    })
  );
  await page.route("**/api/auth/csrf**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ csrfToken: "qa-csrf-token" }),
    })
  );
  await page.route("**/api/auth/signin/google**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "http://127.0.0.1:3100/chat" }),
    })
  );

  await page.goto(
    "/?utm_source=qa-search&utm_medium=cpc&utm_campaign=launch-validation"
  );
  await page.getByTestId("landing-guest-cta").click();
  await expect(page).toHaveURL(/\/chat/);

  // A full reload proves queued events and the first-touch UTM do not depend on
  // module memory or on UTM parameters remaining in the current URL.
  await page.reload();
  await page.getByRole("button", { name: "Allow analytics" }).click();

  await expect
    .poll(() => capturedEvents.map((event) => event.event_name))
    .toEqual(expect.arrayContaining(["landing_view", "cta_start_click"]));

  await page.getByTestId("chat-textarea").fill("Validate campaign funnel");
  await page.getByTestId("chat-textarea").press("Enter");
  await expect(page.getByText("Campaign QA response", { exact: true })).toBeVisible();
  await expect
    .poll(() => capturedEvents.map((event) => event.event_name))
    .toEqual(
      expect.arrayContaining(["chat_started", "first_response_completed"])
    );

  await page.goto("/auth/signin?callbackUrl=%2Fchat");
  await expect
    .poll(() => capturedEvents.map((event) => event.event_name))
    .toContain("signup_page_view");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect
    .poll(() => capturedEvents.map((event) => event.event_name))
    .toContain("signup_started");
  await expect(page).toHaveURL(/\/chat(?:\?|$)/);

  await page.goto("/pricing");
  await page.getByRole("button", { name: "Upgrade to Pro" }).click();
  await page.getByRole("button", { name: "Continue to checkout" }).first().click();
  await expect(page).toHaveURL(/__qa_checkout__/);
  await expect
    .poll(() => capturedEvents.map((event) => event.event_name))
    .toEqual(
      expect.arrayContaining([
        "pricing_view",
        "plan_selected",
        "checkout_started",
      ])
    );
  const checkoutEvent = capturedEvents.find(
    (event) => event.event_name === "checkout_started"
  );
  expect(checkoutEvent?.properties).toMatchObject({
    purchase_type: "subscription",
    product_id: "subscription_pro_monthly",
    monthly_credits_included: 3_000,
    current_plan: "free",
    trigger: "proactive",
    plan_credits_remaining: 0,
    addon_credits_remaining: 0,
  });
  expect(checkoutRequest).toMatchObject({ trigger: "proactive" });

  for (const event of capturedEvents) {
    expect(event).toMatchObject({
      utm_source: "qa-search",
      utm_medium: "cpc",
      utm_campaign: "launch-validation",
    });
  }
});
