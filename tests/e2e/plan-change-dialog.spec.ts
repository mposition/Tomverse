import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/app-fixtures";

/**
 * The Pro <-> Max change screen, against mocked plan-change endpoints.
 *
 * This is the CTA that used to say "Ask support to change plan". What replaces
 * it has to hold three promises that are easy to break and expensive to break:
 *
 *   - the amount is shown before anything is charged;
 *   - confirming an upgrade does not claim the plan has changed, because it
 *     changes when the invoice is paid;
 *   - confirming a change never resumes a cancelled subscription.
 *
 * Every scenario below drives the real component. Stripe is never involved:
 * the preview, confirm and cancel endpoints are mocked, which is the point --
 * what is under test is what the customer is told, not what Stripe does.
 */

type ChangeScenario = {
  plan: "Pro" | "Max";
  /** Body for POST /api/billing/plan-change/preview. */
  preview?: Record<string, unknown>;
  previewStatus?: number;
  /** Body for POST /api/billing/plan-change/confirm. */
  confirm?: Record<string, unknown>;
  confirmStatus?: number;
  /** Body for GET /api/billing/plan-change. */
  existingReservation?: Record<string, unknown> | null;
  cancelStatus?: number;
};

type ChangeHarness = {
  previewRequests: Record<string, unknown>[];
  confirmRequests: Record<string, unknown>[];
  cancelRequests: number;
};

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const UPGRADE_QUOTE = {
  requestId: "pcp_upgrade",
  direction: "upgrade",
  execution: "immediate_upgrade",
  fromTier: "Pro",
  toTier: "Max",
  billingInterval: "monthly",
  currency: "usd",
  amountDueMinor: 742,
  effectiveAt: null,
  renewal: "unaffected",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const DOWNGRADE_QUOTE = {
  requestId: "pcp_downgrade",
  direction: "downgrade",
  execution: "scheduled_downgrade",
  fromTier: "Max",
  toTier: "Pro",
  billingInterval: "monthly",
  currency: "usd",
  amountDueMinor: null,
  effectiveAt: "2026-09-01T00:00:00.000Z",
  renewal: "unaffected",
  expiresAt: "2099-01-01T00:00:00.000Z",
};

async function preparePlanChange(
  page: Page,
  scenario: ChangeScenario
): Promise<ChangeHarness> {
  const harness: ChangeHarness = {
    previewRequests: [],
    confirmRequests: [],
    cancelRequests: 0,
  };

  await page.addInitScript(() => {
    window.localStorage.setItem("tomverse_analytics_consent_v1", "accepted");
    window.localStorage.setItem("tomverse_language", "en");
  });

  await page.route("**/api/analytics/events", (route) =>
    route.fulfill({ status: 202, body: "" })
  );

  await page.route("**/api/auth/session**", (route: Route) =>
    route.fulfill(
      json({
        user: { id: "qa-user", name: "QA", email: "qa@tomverse.app", image: null },
        expires: "2099-01-01T00:00:00.000Z",
      })
    )
  );

  await page.route("**/api/user/usage**", (route) =>
    route.fulfill(
      json({
        plan: scenario.plan,
        subscription: {
          status: "active",
          billingInterval: "monthly",
          currentPeriodEnd: "2026-09-01T00:00:00.000Z",
          cancelAtPeriodEnd: false,
        },
        balances: { planRemainingCredits: 120, purchasedRemainingCredits: 0 },
        limits: { creditsDay: 30, creditsMonth: 300 },
      })
    )
  );

  await page.route("**/api/billing/config**", (route) =>
    route.fulfill(
      json({
        plans: [
          { id: "free", name: "Free", monthlyPriceCents: 0, annualPriceCents: 0, currency: "USD", monthlyMessageLimit: 300 },
          { id: "pro", name: "Pro", monthlyPriceCents: 1_500, annualPriceCents: 14_400, currency: "USD", monthlyMessageLimit: 3_000 },
          { id: "max", name: "Max", monthlyPriceCents: 2_500, annualPriceCents: 24_000, currency: "USD", monthlyMessageLimit: 10_000 },
        ],
        creditPacks: [],
        featuredPromotion: null,
      })
    )
  );

  await page.route("**/api/billing/credit-packs**", (route) =>
    route.fulfill(json({ packs: [], plan: scenario.plan, creditDebt: { credits: 0 } }))
  );

  await page.route("**/api/billing/plan-change/preview", async (route) => {
    harness.previewRequests.push(
      route.request().postDataJSON() as Record<string, unknown>
    );
    const status = scenario.previewStatus ?? 200;
    if (status !== 200) {
      return route.fulfill(json(scenario.preview ?? {}, status));
    }
    return route.fulfill(json({ success: true, quote: scenario.preview }));
  });

  await page.route("**/api/billing/plan-change/confirm", async (route) => {
    harness.confirmRequests.push(
      route.request().postDataJSON() as Record<string, unknown>
    );
    const status = scenario.confirmStatus ?? 200;
    if (status !== 200) {
      return route.fulfill(json(scenario.confirm ?? {}, status));
    }
    return route.fulfill(json({ success: true, reservation: scenario.confirm }));
  });

  // Matched last so the two more specific routes above win.
  await page.route("**/api/billing/plan-change", async (route) => {
    if (route.request().method() === "DELETE") {
      harness.cancelRequests += 1;
      const status = scenario.cancelStatus ?? 200;
      return route.fulfill(
        status === 200 ? json({ success: true }) : json({ code: "NO_SCHEDULED_PLAN_CHANGE" }, status)
      );
    }
    return route.fulfill(
      json({ reservation: scenario.existingReservation ?? null })
    );
  });

  return harness;
}

const openDialog = async (page: Page, target: "pro" | "max") => {
  await page.goto("/pricing?lang=en");
  const cta = page.getByTestId(`pricing-cta-${target}`);
  await expect(cta).toHaveAttribute("data-cta-state", "change_plan");
  await page.getByTestId(`pricing-change-plan-${target}`).click();
  await expect(page.getByTestId("plan-change-modal")).toBeVisible();
};

test.describe("plan change dialog", { tag: "@ui-risk" }, () => {
  test("an upgrade shows the amount before anything is charged", async ({
    page,
  }) => {
    const harness = await preparePlanChange(page, {
      plan: "Pro",
      preview: UPGRADE_QUOTE,
    });
    await openDialog(page, "max");

    // The price the customer is agreeing to, from Stripe's own preview -- not
    // computed here, because every live subscription carries a discount.
    await expect(page.getByTestId("plan-change-amount")).toContainText("$7.42");
    // The quote is a read. Nothing has been confirmed yet.
    expect(harness.confirmRequests).toHaveLength(0);
    expect(harness.previewRequests[0]).toMatchObject({
      targetTier: "Max",
      billingInterval: "monthly",
    });

    await expect(page.getByTestId("plan-change-body")).toContainText(
      "stay on your current plan and are not charged"
    );
  });

  test("confirming an upgrade says the payment is pending, not that the plan changed", async ({
    page,
  }) => {
    await preparePlanChange(page, {
      plan: "Pro",
      preview: UPGRADE_QUOTE,
      confirm: {
        requestId: "pcp_upgrade",
        direction: "upgrade",
        execution: "immediate_upgrade",
        fromTier: "Pro",
        toTier: "Max",
        billingInterval: "monthly",
        status: "pending",
        appliesAt: null,
        cancellable: false,
      },
    });
    await openDialog(page, "max");
    await page.getByTestId("plan-change-confirm").click();

    const reserved = page.getByTestId("plan-change-reserved");
    await expect(reserved).toBeVisible();
    // The plan moves when the invoice is paid. Claiming "Max is active" here
    // would be the exact promise the server refuses to make.
    await expect(reserved).toContainText("Waiting for your payment");
    await expect(reserved).not.toContainText("is active");
  });

  test("a confirm reported as applied says so", async ({ page }) => {
    await preparePlanChange(page, {
      plan: "Pro",
      preview: UPGRADE_QUOTE,
      confirm: {
        requestId: "pcp_upgrade",
        direction: "upgrade",
        execution: "immediate_upgrade",
        fromTier: "Pro",
        toTier: "Max",
        billingInterval: "monthly",
        status: "applied",
        appliesAt: null,
        cancellable: false,
      },
    });
    await openDialog(page, "max");
    await page.getByTestId("plan-change-confirm").click();

    await expect(page.getByTestId("plan-change-reserved")).toContainText(
      "Max is active"
    );
  });

  test("a downgrade quotes no charge and names the date it takes effect", async ({
    page,
  }) => {
    await preparePlanChange(page, {
      plan: "Max",
      preview: DOWNGRADE_QUOTE,
    });
    await openDialog(page, "pro");

    // Nothing is charged at the boundary, so there is no amount to show.
    await expect(page.getByTestId("plan-change-amount")).toHaveCount(0);
    await expect(page.getByTestId("plan-change-body")).toContainText(
      "September 1, 2026"
    );
    await expect(page.getByTestId("plan-change-body")).toContainText("no refund");
  });

  test("a scheduled downgrade can be called off from the same screen", async ({
    page,
  }) => {
    const harness = await preparePlanChange(page, {
      plan: "Max",
      preview: DOWNGRADE_QUOTE,
      existingReservation: {
        requestId: "pcp_downgrade",
        direction: "downgrade",
        execution: "scheduled_downgrade",
        fromTier: "Max",
        toTier: "Pro",
        billingInterval: "monthly",
        status: "pending",
        appliesAt: "2026-09-01T00:00:00.000Z",
        cancellable: true,
      },
    });
    await openDialog(page, "pro");

    // A change already in flight wins over a new quote: offering to start a
    // second one is what the server refuses.
    await expect(page.getByTestId("plan-change-reserved")).toContainText(
      "Pro is scheduled"
    );
    expect(harness.previewRequests).toHaveLength(0);

    await page.getByTestId("plan-change-cancel-scheduled").click();
    await expect(page.getByTestId("plan-change-cancelled")).toBeVisible();
    expect(harness.cancelRequests).toBe(1);
  });

  test("an applied change offers no cancel button", async ({ page }) => {
    await preparePlanChange(page, {
      plan: "Max",
      preview: DOWNGRADE_QUOTE,
      existingReservation: {
        requestId: "pcp_downgrade",
        direction: "downgrade",
        execution: "scheduled_downgrade",
        fromTier: "Max",
        toTier: "Pro",
        billingInterval: "monthly",
        status: "pending",
        appliesAt: "2026-09-01T00:00:00.000Z",
        cancellable: false,
      },
    });
    await openDialog(page, "pro");

    await expect(page.getByTestId("plan-change-reserved")).toBeVisible();
    await expect(page.getByTestId("plan-change-cancel-scheduled")).toHaveCount(0);
  });

  test("resuming a cancelled subscription is its own tick box, never the confirm", async ({
    page,
  }) => {
    const harness = await preparePlanChange(page, {
      plan: "Pro",
      preview: { ...UPGRADE_QUOTE, renewal: "cancellation_preserved" },
      confirm: {
        requestId: "pcp_upgrade",
        direction: "upgrade",
        execution: "immediate_upgrade",
        fromTier: "Pro",
        toTier: "Max",
        billingInterval: "monthly",
        status: "pending",
        appliesAt: null,
        cancellable: false,
      },
    });
    await openDialog(page, "max");

    const resume = page.getByTestId("plan-change-resume-renewal");
    await expect(resume).toBeVisible();
    await expect(resume).not.toBeChecked();
    // Unticked, the screen has to say the subscription still ends.
    await expect(page.getByTestId("plan-change-modal")).toContainText(
      "still ends at the end of this period"
    );

    await page.getByTestId("plan-change-confirm").click();
    // Confirming a plan change is not consent to start renewing again.
    expect(harness.confirmRequests[0]).not.toHaveProperty("resumeRenewal");
  });

  test("ticking the renewal box is what sends the consent", async ({ page }) => {
    const harness = await preparePlanChange(page, {
      plan: "Pro",
      preview: { ...UPGRADE_QUOTE, renewal: "cancellation_preserved" },
      confirm: {
        requestId: "pcp_upgrade",
        direction: "upgrade",
        execution: "immediate_upgrade",
        fromTier: "Pro",
        toTier: "Max",
        billingInterval: "monthly",
        status: "pending",
        appliesAt: null,
        cancellable: false,
      },
    });
    await openDialog(page, "max");

    await page.getByTestId("plan-change-resume-renewal").check();
    await page.getByTestId("plan-change-confirm").click();
    expect(harness.confirmRequests[0]).toMatchObject({ resumeRenewal: true });
  });

  test("a stale quote is refused with a way back, not with the server's words", async ({
    page,
  }) => {
    await preparePlanChange(page, {
      plan: "Pro",
      preview: UPGRADE_QUOTE,
      confirmStatus: 409,
      confirm: {
        code: "PLAN_CHANGE_PREVIEW_EXPIRED",
        error: "The quote is no longer valid (state_changed); request a new one.",
      },
    });
    await openDialog(page, "max");
    await page.getByTestId("plan-change-confirm").click();

    const error = page.getByTestId("plan-change-error");
    await expect(error).toHaveAttribute(
      "data-error-code",
      "PLAN_CHANGE_PREVIEW_EXPIRED"
    );
    // The visitor is told what to do next, in the product's own words.
    await expect(error).toContainText("Start again to see the current one");
    await expect(error).not.toContainText("state_changed");
    await expect(page.getByTestId("plan-change-retry")).toBeVisible();
  });

  test("a refusal only a person can clear offers support, not a retry", async ({
    page,
  }) => {
    // Retrying a schedule conflict produces the same refusal every time.
    await preparePlanChange(page, {
      plan: "Max",
      previewStatus: 409,
      preview: { code: "SUBSCRIPTION_SCHEDULE_CONFLICT", error: "conflict" },
    });
    await openDialog(page, "pro");

    await expect(page.getByTestId("plan-change-error")).toHaveAttribute(
      "data-error-code",
      "SUBSCRIPTION_SCHEDULE_CONFLICT"
    );
    await expect(page.getByTestId("plan-change-retry")).toHaveCount(0);
    const support = page.getByTestId("plan-change-support");
    const href = new URL(
      (await support.getAttribute("href"))!,
      "http://127.0.0.1:3100"
    );
    expect(href.pathname).toBe("/support");
    expect(href.searchParams.get("topic")).toBe("billing");
  });

  test("a double-clicked confirm reaches the server once", async ({ page }) => {
    const reservation = {
      requestId: "pcp_upgrade",
      direction: "upgrade",
      execution: "immediate_upgrade",
      fromTier: "Pro",
      toTier: "Max",
      billingInterval: "monthly",
      status: "pending",
      appliesAt: null,
      cancellable: false,
    };
    const harness = await preparePlanChange(page, {
      plan: "Pro",
      preview: UPGRADE_QUOTE,
      confirm: reservation,
    });

    // The confirm response is held open so that both clicks land while the
    // first request is still in flight -- which is the only state the
    // single-flight guard exists for.
    //
    // Letting the mock answer immediately made the outcome a race the test did
    // not control. On mobile the dialog re-rendered into its reserved stage
    // before the second click started, the confirm button was gone with it,
    // and `click()` then waited for an element that was never coming back
    // until the whole test timed out -- reported against the next line, as a
    // reserved panel that "never appeared" while the page snapshot showed it
    // plainly on screen. Desktop won the same race the other way and passed.
    // Registered after preparePlanChange so this handler wins the route.
    let confirmArrived = () => {};
    const firstConfirm = new Promise<void>((resolve) => {
      confirmArrived = resolve;
    });
    let releaseConfirm = () => {};
    const held = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    await page.route("**/api/billing/plan-change/confirm", async (route) => {
      harness.confirmRequests.push(
        route.request().postDataJSON() as Record<string, unknown>
      );
      confirmArrived();
      await held;
      await route.fulfill(json({ success: true, reservation }));
    });

    await openDialog(page, "max");

    const confirm = page.getByTestId("plan-change-confirm");
    await confirm.click();
    await firstConfirm;
    // Still mounted, and disabled: that is what has to stop the second click
    // from reaching the server, rather than the button happening to vanish.
    await expect(confirm).toBeDisabled();
    await confirm.click({ force: true, trial: false, timeout: 2_000 }).catch(() => {});
    releaseConfirm();

    await expect(page.getByTestId("plan-change-reserved")).toBeVisible();
    expect(harness.confirmRequests).toHaveLength(1);
  });

  test("Escape closes the dialog and returns focus to the CTA", async ({
    page,
  }) => {
    await preparePlanChange(page, { plan: "Pro", preview: UPGRADE_QUOTE });
    await openDialog(page, "max");

    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plan-change-modal")).toHaveCount(0);
    await expect(page.getByTestId("pricing-change-plan-max")).toBeFocused();
  });

  test("the dialog fits a 320px viewport at 200% text", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.addInitScript(() => {
      document.documentElement.style.fontSize = "32px";
    });
    await preparePlanChange(page, { plan: "Pro", preview: UPGRADE_QUOTE });
    await openDialog(page, "max");

    await expect(page.getByTestId("plan-change-amount")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
