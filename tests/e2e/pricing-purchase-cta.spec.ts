import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/app-fixtures";

/**
 * The pricing page's purchase funnel, end to end, without touching Stripe.
 *
 * The defect this covers: `/pricing` rendered "Sign in to buy credits" ->
 * `/chat` for every visitor, signed in or not. A signed-in visitor who clicked
 * it left the pricing page, landed on the chat welcome screen, and could not
 * start a purchase at all -- and every plan card offered the same "Upgrade"
 * button regardless of the plan the account was already on, so a Pro
 * subscriber's click reached a checkout the server answers with 409.
 *
 * Everything below drives the real components against mocked session, usage,
 * credit-pack and checkout endpoints, so the whole state machine -- session
 * loading, signed out, Free, Pro, Max, sign-in round trip, Stripe return, and
 * every documented failure -- is exercised without a payment.
 */

type CapturedEvent = {
  event_name: string;
  properties: Record<string, unknown>;
};

type PricingScenario = {
  /** null renders the signed-out page. */
  plan: "Free" | "Pro" | "Max" | null;
  hasActiveSubscription?: boolean;
  /**
   * The interval the subscription bills on. Explicitly settable to null: a
   * subscription synced before the field existed has none, and the plan-change
   * CTA has to fall back to support rather than open a flow the server refuses.
   */
  billingInterval?: "monthly" | "annual" | null;
  /** Delays the session response so the loading state can be observed. */
  sessionDelayMs?: number;
  /** Status for GET /api/billing/credit-packs. */
  packsStatus?: number;
  /** Status for POST /api/billing/credit-packs. */
  checkoutStatus?: number;
  /** Error code the POST returns, when the route classifies its own failure. */
  checkoutErrorCode?: string;
  language?: "en" | "ko";
};

type PricingHarness = {
  events: CapturedEvent[];
  checkoutRequests: Record<string, unknown>[];
  usageRequests: number;
  checkoutUrl: string;
};

const PACKS = [
  {
    id: "starter_500",
    name: "Starter Credit Pack",
    credits: 500,
    priceMinor: 499,
    priceCents: 499,
    currency: "USD",
    validityDays: 365,
    allowedPlans: ["Free"],
  },
  {
    id: "project_1500",
    name: "Project Credit Pack",
    credits: 1_500,
    priceMinor: 999,
    priceCents: 999,
    currency: "USD",
    validityDays: 365,
    allowedPlans: ["Pro", "Max"],
  },
  {
    id: "power_4000",
    name: "Power Credit Pack",
    credits: 4_000,
    priceMinor: 1_999,
    priceCents: 1_999,
    currency: "USD",
    validityDays: 365,
    allowedPlans: ["Pro", "Max"],
  },
] as const;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const packsForPlan = (plan: "Free" | "Pro" | "Max") =>
  PACKS.filter((pack) => (pack.allowedPlans as readonly string[]).includes(plan));

async function preparePricingPage(
  page: Page,
  scenario: PricingScenario
): Promise<PricingHarness> {
  const harness: PricingHarness = {
    events: [],
    checkoutRequests: [],
    usageRequests: 0,
    // Stands in for Stripe. Same-origin so the E2E network guard allows the
    // navigation, and it carries the exact query Stripe's success_url would.
    checkoutUrl: "http://127.0.0.1:3100/__qa_stripe__",
  };
  const language = scenario.language ?? "en";

  await page.addInitScript((lang) => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
    window.localStorage.setItem("tomverse_language", lang);
  }, language);

  await page.route("**/api/analytics/events", async (route) => {
    harness.events.push(route.request().postDataJSON() as CapturedEvent);
    await route.fulfill({ status: 202, body: "" });
  });

  await page.route("**/api/auth/session**", async (route: Route) => {
    if (scenario.sessionDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, scenario.sessionDelayMs)
      );
    }
    if (!scenario.plan) return route.fulfill(json(null));
    return route.fulfill(
      json({
        user: {
          id: "qa-user",
          name: "QA User",
          email: "qa@tomverse.app",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      })
    );
  });

  await page.route("**/api/user/usage**", (route) => {
    harness.usageRequests += 1;
    if (!scenario.plan) return route.fulfill(json({ error: "no" }, 401));
    return route.fulfill(
      json({
        plan: scenario.plan,
        subscription: {
          status: scenario.hasActiveSubscription ? "active" : null,
          billingInterval: scenario.hasActiveSubscription
            ? scenario.billingInterval === undefined
              ? "monthly"
              : scenario.billingInterval
            : null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: false,
        },
        balances: {
          planRemainingCredits: 120,
          purchasedRemainingCredits: 40,
        },
        limits: { creditsDay: 30, creditsMonth: 300 },
      })
    );
  });

  await page.route("**/api/billing/config**", (route) =>
    route.fulfill(
      json({
        plans: [
          {
            id: "free",
            name: "Free",
            monthlyPriceCents: 0,
            annualPriceCents: 0,
            currency: "USD",
            monthlyMessageLimit: 300,
          },
          {
            id: "pro",
            name: "Pro",
            monthlyPriceCents: 1_500,
            annualPriceCents: 14_400,
            currency: "USD",
            monthlyMessageLimit: 3_000,
          },
          {
            id: "max",
            name: "Max",
            monthlyPriceCents: 2_500,
            annualPriceCents: 24_000,
            currency: "USD",
            monthlyMessageLimit: 10_000,
          },
        ],
        creditPacks: PACKS,
        featuredPromotion: null,
      })
    )
  );

  await page.route("**/api/billing/credit-packs**", async (route) => {
    if (route.request().method() === "POST") {
      harness.checkoutRequests.push(
        route.request().postDataJSON() as Record<string, unknown>
      );
      const status = scenario.checkoutStatus ?? 200;
      if (status === 401) {
        return route.fulfill(
          json({ code: "AUTHENTICATION_REQUIRED", error: "Authentication required." }, 401)
        );
      }
      if (status !== 200) {
        return route.fulfill(
          json(
            scenario.checkoutErrorCode
              ? { code: scenario.checkoutErrorCode, error: "nope" }
              : { error: "nope" },
            status
          )
        );
      }
      return route.fulfill(json({ url: harness.checkoutUrl }));
    }
    const status = scenario.packsStatus ?? 200;
    if (status === 401) {
      return route.fulfill(
        json({ code: "AUTHENTICATION_REQUIRED", error: "Authentication required." }, 401)
      );
    }
    return route.fulfill(
      json({
        plan: scenario.plan ?? "Free",
        market: { country: "US", currency: "USD" },
        packs: packsForPlan(scenario.plan ?? "Free"),
        analyticsContext: {
          currentPlan: (scenario.plan ?? "Free").toLowerCase(),
          planCreditsRemaining: 120,
          addonCreditsRemaining: 40,
        },
        balance: { remainingCredits: 40, earliestExpiry: null },
        creditDebt: { credits: 0, fundedCostMicroUsd: 0, riskStatus: "normal" },
      })
    );
  });

  await page.route("**/__qa_stripe__**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>QA Stripe</title><p>stripe stand-in</p>",
    })
  );

  return harness;
}

const gotoPricing = async (page: Page, query = "?lang=en") => {
  await page.goto(`/pricing${query}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
};

const ctaState = (page: Page, planId: "free" | "pro" | "max") =>
  page.getByTestId(`pricing-cta-${planId}`);

const eventNames = (harness: PricingHarness) =>
  harness.events.map((event) => event.event_name);

const eventsNamed = (harness: PricingHarness, name: string) =>
  harness.events.filter((event) => event.event_name === name);

test.describe("pricing plan CTAs by authentication state and plan", () => {
  test("a signed-out visitor is offered sign-in on every paid plan", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: null });
    await gotoPricing(page);

    await expect(ctaState(page, "free")).toHaveAttribute(
      "data-cta-state",
      "signed_out"
    );
    await expect(ctaState(page, "free")).toContainText("Start free");
    await expect(ctaState(page, "pro")).toHaveAttribute(
      "data-cta-state",
      "signed_out"
    );
    await expect(ctaState(page, "pro")).toContainText("Sign in to start Pro");
    await expect(ctaState(page, "max")).toContainText("Sign in to start Max");
    await expect(page.getByTestId("credit-pack-section-cta")).toContainText(
      "Sign in to buy credits"
    );
  });

  test("a signed-in Free account is offered both upgrades and a credit purchase", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Free" });
    await gotoPricing(page);

    await expect(ctaState(page, "free")).toHaveAttribute(
      "data-cta-state",
      "current_plan"
    );
    await expect(
      ctaState(page, "free").getByRole("button", { name: "Current plan" })
    ).toBeDisabled();
    await expect(ctaState(page, "pro")).toHaveAttribute(
      "data-cta-state",
      "upgrade"
    );
    await expect(ctaState(page, "pro")).toContainText("Upgrade to Pro");
    await expect(ctaState(page, "max")).toContainText("Upgrade to Max");

    const creditCta = page.getByTestId("credit-pack-section-cta");
    await expect(creditCta).toHaveAttribute("data-cta-state", "authenticated");
    await expect(creditCta).toContainText("Buy additional credits");
    await expect(creditCta).not.toContainText("Sign in");
  });

  test("a Pro subscriber is never offered Pro again, and Max opens the change flow", async ({
    page,
  }) => {
    await preparePricingPage(page, {
      plan: "Pro",
      hasActiveSubscription: true,
    });
    await gotoPricing(page);

    await expect(ctaState(page, "pro")).toHaveAttribute(
      "data-cta-state",
      "current_plan"
    );
    await expect(ctaState(page, "pro")).toContainText("Current plan");

    // Not a checkout: /api/billing/checkout refuses a plan change with 409 and
    // always will, so this CTA opens the dedicated change screen instead.
    const maxCta = ctaState(page, "max");
    await expect(maxCta).toHaveAttribute("data-cta-state", "change_plan");
    await expect(maxCta).not.toContainText("not supported yet");
    await expect(page.getByTestId("pricing-change-plan-max")).toBeVisible();

    // A paying account is not shown a sign-up button for Free.
    await expect(ctaState(page, "free")).toHaveAttribute(
      "data-cta-state",
      "hidden"
    );
    await expect(ctaState(page, "free")).toBeEmpty();
  });

  test("a subscription with no known interval is handed to support, not to a refusal", async ({
    page,
  }) => {
    // A change only ever happens on the interval already being billed. Without
    // one, opening the flow would show a price and then refuse the confirm.
    await preparePricingPage(page, {
      plan: "Pro",
      hasActiveSubscription: true,
      billingInterval: null,
    });
    await gotoPricing(page);

    const maxCta = ctaState(page, "max");
    await expect(maxCta).toHaveAttribute("data-cta-state", "manage_plan");
    await expect(maxCta).toContainText("not supported yet");

    await maxCta.getByRole("link", { name: "Ask support to change plan" }).click();

    await page.waitForURL(/\/support/);
    // Landing on a generic contact page would make this a redirect, not a
    // handoff: the visitor would have to re-explain what they were doing.
    await expect(page.getByLabel("Request type")).toHaveValue("billing");
  });

  test("a Max subscriber is never told that Pro is an upgrade", async ({
    page,
  }) => {
    await preparePricingPage(page, {
      plan: "Max",
      hasActiveSubscription: true,
    });
    await gotoPricing(page);

    await expect(ctaState(page, "max")).toHaveAttribute(
      "data-cta-state",
      "current_plan"
    );
    const proCta = ctaState(page, "pro");
    await expect(proCta).toHaveAttribute("data-cta-state", "change_plan");
    // "Upgrade to Pro" is what a Max subscriber used to be shown: it reads as
    // a promotion and describes a demotion.
    await expect(proCta).not.toContainText("Upgrade");
    await expect(proCta).toContainText("Change to Pro");
    await expect(page.getByTestId("credit-pack-section-cta")).toContainText(
      "Buy additional credits"
    );
  });

  test("no signed-out CTA is shown before the session resolves", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro", sessionDelayMs: 1_500 });
    await page.goto("/pricing?lang=en");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    const creditCta = page.getByTestId("credit-pack-section-cta");
    await expect(creditCta).toHaveAttribute("data-cta-state", "loading");
    await expect(creditCta).toContainText("Checking your account");
    // The two wrong answers, either of which would flicker into view and then
    // be replaced once the session landed.
    await expect(creditCta).not.toContainText("Sign in to buy credits");
    await expect(creditCta).not.toContainText("Buy additional credits");
    await expect(ctaState(page, "pro")).toHaveAttribute(
      "data-cta-state",
      "loading"
    );
    // The loading state is announced, not just drawn.
    await expect(
      page.getByText("Checking your sign-in status", { exact: false })
    ).toBeAttached();

    await expect(creditCta).toHaveAttribute("data-cta-state", "authenticated", {
      timeout: 10_000,
    });
  });
});

test.describe("credit-pack purchase from the pricing page", () => {
  test("a signed-in visitor opens the purchase modal without leaving the page", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(page);

    const creditCta = page.getByTestId("credit-pack-section-cta");
    await expect(creditCta).toHaveAttribute("data-cta-state", "authenticated");
    const urlBefore = page.url();

    await creditCta.click();

    await expect(page.getByTestId("credit-pack-modal")).toBeVisible();
    // The reported failure was a navigation to /chat instead of a modal.
    expect(page.url()).toBe(urlBefore);
    expect(new URL(page.url()).pathname).toBe("/pricing");
    await expect(
      page.getByTestId("credit-pack-buy-project_1500")
    ).toBeVisible();
  });

  test("a pack card opens the modal on the pack that was clicked", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-card-cta-power_4000").click();
    const modal = page.getByTestId("credit-pack-modal");
    await expect(modal).toBeVisible();

    const chosen = modal.locator('[data-pack-id="power_4000"]');
    await expect(chosen).toHaveAttribute("data-selected", "true");
    await expect(
      modal.locator('[data-pack-id="project_1500"]')
    ).toHaveAttribute("data-selected", "false");
    // Preferred pack is presented first, not buried in the grid.
    await expect(modal.locator("[data-pack-id]").first()).toHaveAttribute(
      "data-pack-id",
      "power_4000"
    );
  });

  test("buying a pack starts exactly one checkout session, however fast the clicks", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-card-cta-project_1500").click();
    const buyButton = page.getByTestId("credit-pack-buy-project_1500");
    await expect(buyButton).toBeVisible();

    // Three clicks inside one frame: `disabled` alone cannot stop these,
    // because the state update that sets it has not committed yet.
    await buyButton.evaluate((node: HTMLElement) => {
      node.click();
      node.click();
      node.click();
    });

    await page.waitForURL(/__qa_stripe__/);
    expect(harness.checkoutRequests).toHaveLength(1);
    expect(harness.checkoutRequests[0].packId).toBe("project_1500");
    expect(eventsNamed(harness, "checkout_started")).toHaveLength(1);
  });

  test("the checkout request proposes a same-origin pricing return, never a raw URL", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(page, "?lang=ko");

    await page.getByTestId("credit-pack-card-cta-project_1500").click();
    await page.getByTestId("credit-pack-buy-project_1500").click();
    await page.waitForURL(/__qa_stripe__/);

    const returnTo = String(harness.checkoutRequests[0].returnTo ?? "");
    expect(returnTo.startsWith("/")).toBe(true);
    expect(returnTo.startsWith("//")).toBe(false);
    expect(returnTo).toContain("/pricing");
    expect(returnTo).toContain("#credit-packs");
    expect(harness.checkoutRequests[0].language).toBe("ko");
  });
});

test.describe("the sign-in round trip keeps the purchase intent", () => {
  test("a signed-out credit CTA carries the pack, the language and the section back", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: null });
    await gotoPricing(page, "?lang=ko&utm_source=qa&utm_medium=e2e");

    const packCta = page.getByTestId("credit-pack-card-cta-project_1500");
    // The CTA is a neutral span until the session resolves; reading its href
    // before then is reading the loading state, not the signed-out one.
    await expect(packCta).toHaveAttribute("data-cta-state", "signed_out");
    const href = await packCta.getAttribute("href");
    expect(href).toBeTruthy();

    const signIn = new URL(href!, "http://127.0.0.1:3100");
    expect(signIn.pathname).toBe("/auth/signin");
    const callbackUrl = signIn.searchParams.get("callbackUrl") ?? "";
    expect(callbackUrl.startsWith("/pricing")).toBe(true);

    const callback = new URL(callbackUrl, "http://127.0.0.1:3100");
    expect(callback.searchParams.get("intent")).toBe("credit_pack");
    expect(callback.searchParams.get("pack")).toBe("project_1500");
    expect(callback.searchParams.get("lang")).toBe("ko");
    expect(callback.searchParams.get("utm_source")).toBe("qa");
    expect(callback.hash).toBe("#credit-packs");
  });

  test("a resumed purchase reopens the pack picker and charges nothing", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, { plan: "Pro" });
    // Exactly the URL the sign-in callback lands on.
    await gotoPricing(
      page,
      "?lang=en&intent=credit_pack&pack=power_4000&trigger=usage_widget#credit-packs"
    );

    const modal = page.getByTestId("credit-pack-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator('[data-pack-id="power_4000"]')).toHaveAttribute(
      "data-selected",
      "true"
    );

    // The purchase must not auto-run: the visitor confirms it themselves.
    expect(harness.checkoutRequests).toHaveLength(0);
    expect(eventNames(harness)).not.toContain("checkout_started");
    expect(page.url()).not.toContain("__qa_stripe__");
    await expect
      .poll(() => eventNames(harness))
      .toContain("purchase_intent_resumed");

    // The intent is spent: a refresh must not reopen it.
    await expect.poll(() => page.url()).not.toContain("intent=credit_pack");
  });

  test("an upgrade link from elsewhere lands on the plan card it named", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Free" });
    await gotoPricing(
      page,
      "?lang=en&intent=subscription&target=max&trigger=account#plans"
    );

    const maxCard = page.getByTestId("pricing-plan-card-max");
    await expect(maxCard).toHaveAttribute("data-requested-target", "true");
    await expect(page.getByTestId("pricing-plan-card-pro")).not.toHaveAttribute(
      "data-requested-target",
      "true"
    );
    // Identified in the accessibility tree too, not by the ring alone.
    await expect(maxCard.getByText("Upgrade to Max")).toHaveCount(2);
  });
});

test.describe("expired sessions and failed checkouts", () => {
  test("a 401 while loading packs offers re-authentication, not a loading error", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, {
      plan: "Pro",
      packsStatus: 401,
    });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-section-cta").click();
    const error = page.getByTestId("credit-pack-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("data-error-code", "SESSION_EXPIRED");
    await expect(error).toContainText("session has expired");

    const reauth = page.getByTestId("credit-pack-reauthenticate");
    await expect(reauth).toBeVisible();
    const href = new URL(
      (await reauth.getAttribute("href"))!,
      "http://127.0.0.1:3100"
    );
    expect(href.pathname).toBe("/auth/signin");
    expect(href.searchParams.get("callbackUrl")).toContain("/pricing");
    // A generic "could not be loaded" retry would loop straight back into 401.
    await expect(page.getByTestId("credit-pack-retry")).toHaveCount(0);
    await expect
      .poll(() => eventNames(harness))
      .toContain("authentication_required");
  });

  test("a 401 while creating the session keeps the chosen pack recoverable", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, {
      plan: "Pro",
      checkoutStatus: 401,
    });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-card-cta-project_1500").click();
    await page.getByTestId("credit-pack-buy-project_1500").click();

    const error = page.getByTestId("credit-pack-error");
    await expect(error).toHaveAttribute("data-error-code", "SESSION_EXPIRED");
    await expect(page.getByTestId("credit-pack-reauthenticate")).toBeVisible();
    // Still on the pricing page, with the pack still selected.
    expect(new URL(page.url()).pathname).toBe("/pricing");
    await expect(
      page.getByTestId("credit-pack-modal").locator('[data-pack-id="project_1500"]')
    ).toHaveAttribute("data-selected", "true");
    await expect
      .poll(() => eventsNamed(harness, "checkout_failed").length)
      .toBeGreaterThan(0);
    expect(
      eventsNamed(harness, "checkout_failed")[0].properties.error_code
    ).toBe("session_expired");
  });

  test("an unclassified server failure is retryable and never shows raw server text", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro", checkoutStatus: 500 });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-card-cta-power_4000").click();
    await page.getByTestId("credit-pack-buy-power_4000").click();

    const error = page.getByTestId("credit-pack-error");
    await expect(error).toBeVisible();
    await expect(error).toHaveAttribute("data-error-code", "UNKNOWN_ERROR");
    await expect(error).toContainText("could not be started");
    // A failure the visitor can act on offers a retry, not a support ticket.
    await expect(page.getByTestId("credit-pack-retry")).toBeVisible();
    await expect(page.getByTestId("credit-pack-reauthenticate")).toHaveCount(0);
    // The server's own wording never reaches the customer.
    await expect(error).not.toContainText("nope");
    await expect(error).not.toContainText("500");
  });

  test("a pack the plan cannot buy is explained, not silently dropped", async ({
    page,
  }) => {
    // The public catalogue lists all three packs with their eligible plans, so
    // a Free visitor can click a Pro-only one. The modal used to just quietly
    // not have it, leaving them looking at a picker that had changed its mind.
    await preparePricingPage(page, { plan: "Free" });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-card-cta-power_4000").click();
    const error = page.getByTestId("credit-pack-error");
    await expect(error).toHaveAttribute(
      "data-error-code",
      "PACK_NOT_AVAILABLE_FOR_PLAN"
    );
    await expect(error).toContainText("not available on your current plan");

    // The fix is on screen: the pack this plan *can* buy is still purchasable,
    // so neither a retry nor a support ticket is offered.
    await expect(page.getByTestId("credit-pack-buy-starter_500")).toBeVisible();
    await expect(page.getByTestId("credit-pack-retry")).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Contact support" })
    ).toHaveCount(0);
  });

  test("a configuration failure sends the visitor to support, not round a retry loop", async ({
    page,
  }) => {
    await preparePricingPage(page, {
      plan: "Pro",
      checkoutStatus: 503,
      checkoutErrorCode: "CHECKOUT_CONFIGURATION_ERROR",
    });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-card-cta-power_4000").click();
    await page.getByTestId("credit-pack-buy-power_4000").click();

    const error = page.getByTestId("credit-pack-error");
    await expect(error).toHaveAttribute(
      "data-error-code",
      "CHECKOUT_CONFIGURATION_ERROR"
    );
    await expect(error).toContainText("Nothing was charged");
    await expect(
      page.getByRole("link", { name: "Contact support" })
    ).toBeVisible();
    await expect(page.getByTestId("credit-pack-retry")).toHaveCount(0);
  });
});

test.describe("returning from Stripe", () => {
  test("a completed purchase is acknowledged in the section it started from", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(
      page,
      "?lang=en&billing=credits-success&pack=project_1500#credit-packs"
    );

    const outcome = page.getByTestId("pricing-credit-outcome");
    await expect(outcome).toBeVisible();
    await expect(outcome).toHaveAttribute("data-outcome", "credits-success");
    await expect(outcome).toContainText("Project Credit Pack");
    // The announcement is consumed: a refresh must not repeat it.
    await expect.poll(() => page.url()).not.toContain("billing=");
  });

  test("a cancelled purchase restores the pack and the section, not a bare page", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(
      page,
      "?lang=en&billing=credits-cancelled&pack=power_4000#credit-packs"
    );

    const outcome = page.getByTestId("pricing-credit-outcome");
    await expect(outcome).toHaveAttribute("data-outcome", "credits-cancelled");
    await expect(outcome).toContainText("Power Credit Pack");
    await expect(outcome).toContainText("not charged");

    // The section CTA resumes on the pack that was abandoned.
    await page.getByTestId("credit-pack-section-cta").click();
    await expect(
      page.getByTestId("credit-pack-modal").locator('[data-pack-id="power_4000"]')
    ).toHaveAttribute("data-selected", "true");

    await expect
      .poll(() => eventNames(harness))
      .toContain("checkout_cancelled");
    // A cancellation is not a failure and must not inflate the error rate.
    expect(eventNames(harness)).not.toContain("checkout_failed");
  });

  test("a cancelled subscription checkout is acknowledged on the plans", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Free" });
    await gotoPricing(page, "?lang=en&billing=cancelled&plan=pro#plans");

    await expect(
      page.getByTestId("pricing-subscription-cancelled")
    ).toBeVisible();
    await expect(
      page.getByTestId("pricing-subscription-cancelled")
    ).toContainText("Pro");
  });
});

test.describe("purchase funnel analytics", () => {
  test("the funnel is one connected sequence, with no duplicated steps", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, { plan: "Free" });
    await gotoPricing(page, "?lang=en&utm_source=qa&utm_medium=e2e");

    const sectionCta = page.getByTestId("credit-pack-section-cta");
    await expect(sectionCta).toHaveAttribute("data-cta-state", "authenticated");
    await sectionCta.scrollIntoViewIfNeeded();
    await expect
      .poll(() => eventNames(harness))
      .toContain("credit_pack_cta_view");

    await page.getByTestId("credit-pack-card-cta-starter_500").click();
    await expect(page.getByTestId("credit-pack-modal")).toBeVisible();
    await page.getByTestId("credit-pack-buy-starter_500").click();
    await page.waitForURL(/__qa_stripe__/);

    const names = eventNames(harness);
    for (const step of [
      "pricing_view",
      "credit_pack_cta_view",
      "credit_pack_cta_click",
      "credit_pack_selected",
      "checkout_started",
    ]) {
      expect(names, `missing ${step}`).toContain(step);
    }
    // Impressions and checkout starts are deduplicated; a repeated
    // `checkout_started` would double-count revenue intent in GA4.
    expect(eventsNamed(harness, "credit_pack_cta_view")).toHaveLength(1);
    expect(eventsNamed(harness, "pricing_view")).toHaveLength(1);
    expect(eventsNamed(harness, "checkout_started")).toHaveLength(1);

    const started = eventsNamed(harness, "checkout_started")[0];
    expect(started.properties.purchase_type).toBe("credit_pack");
    expect(started.properties.pack_id).toBe("starter_500");
    expect(started.properties.credits_purchased).toBe(500);
    expect(started.properties.current_plan).toBe("free");
    expect(started.properties.authentication_state).toBe("authenticated");
    expect(started.properties.currency).toBe("USD");

    const impression = eventsNamed(harness, "credit_pack_cta_view")[0];
    expect(impression.properties.authentication_state).toBe("authenticated");

    // No customer identity is ever attached to an analytics event.
    const serialised = JSON.stringify(harness.events);
    expect(serialised).not.toContain("qa@tomverse.app");
    expect(serialised).not.toContain("QA User");
  });

  test("a signed-out CTA click is recorded as needing authentication", async ({
    page,
  }) => {
    const harness = await preparePricingPage(page, { plan: null });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-section-cta").click();
    await expect
      .poll(() => eventNames(harness))
      .toContain("credit_pack_cta_click");
    const click = eventsNamed(harness, "credit_pack_cta_click")[0];
    expect(click.properties.authentication_state).toBe("unauthenticated");
  });
});

test.describe("purchase modal accessibility", () => {
  test("the modal traps focus, closes on Escape, and gives focus back", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(page);

    const trigger = page.getByTestId("credit-pack-section-cta");
    await expect(trigger).toHaveAttribute("data-cta-state", "authenticated");
    await trigger.focus();
    await page.keyboard.press("Enter");

    const modal = page.getByTestId("credit-pack-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toHaveAttribute("aria-modal", "true");
    await expect(modal).toHaveAttribute("role", "dialog");
    await expect(page.getByTestId("credit-pack-modal-close")).toBeFocused();

    // Tab all the way round: focus must never leave the dialog.
    for (let step = 0; step < 12; step += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const dialog = document.querySelector('[data-testid="credit-pack-modal"]');
        return Boolean(dialog && dialog.contains(document.activeElement));
      });
      expect(inside, `focus escaped the dialog after ${step + 1} tabs`).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("every purchase control clears the 44px touch-target floor", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro" });
    await gotoPricing(page);

    await page.getByTestId("credit-pack-section-cta").click();
    await expect(page.getByTestId("credit-pack-modal")).toBeVisible();

    for (const testId of [
      "credit-pack-modal-close",
      "credit-pack-buy-project_1500",
      "credit-pack-buy-power_4000",
    ]) {
      const box = await page.getByTestId(testId).boundingBox();
      expect(box, `${testId} has no box`).not.toBeNull();
      expect(box!.height, `${testId} height`).toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe("pricing purchase CTAs at 320px and 200% text", () => {
  test("neither the CTAs nor the modal push the page sideways", async ({
    page,
  }) => {
    await preparePricingPage(page, { plan: "Pro" });
    await page.setViewportSize({ width: 320, height: 720 });
    await page.addInitScript(() => {
      const style = document.createElement("style");
      style.textContent = ":root { font-size: 32px; }";
      document.documentElement.appendChild(style);
    });
    await gotoPricing(page);

    await expectNoHorizontalOverflow(page);

    await page.getByTestId("credit-pack-section-cta").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("credit-pack-section-cta")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.getByTestId("credit-pack-section-cta").click();
    await expect(page.getByTestId("credit-pack-modal")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
