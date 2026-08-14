import {
  FIXTURE_CUSTOMERS,
  FIXTURE_PROMOTION,
  adminApi,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * "Promotion diagnostics", inside Billing's Promotions section.
 *
 * The behaviour under test is the reason the panel was built: an operator can
 * investigate a promotion that refuses at Checkout without creating an account
 * to try it with. So the spec never signs up anybody -- it diagnoses the
 * configuration alone, then diagnoses it against a customer the fixtures
 * already seeded -- and it checks afterwards that the promotion, its
 * redemptions and the account are exactly as they were.
 *
 * Stripe is deliberately unconfigured on this harness, so the linkage section
 * reports "not checked" rather than inventing a verdict. That is the assertion,
 * not a limitation: a diagnostics tool that guessed at Stripe when it could not
 * reach it would be worse than one that says so.
 */

const panel = (page: import("@playwright/test").Page) =>
  page.getByTestId("promotion-diagnostics-panel");

const openPromotions = async (page: import("@playwright/test").Page) => {
  await page.goto("/admin/billing?tab=promotions");
  await expect(panel(page)).toBeVisible();
};

const runDiagnostics = async (page: import("@playwright/test").Page) => {
  await page.getByTestId("promotion-diagnostics-run").click();
  await expect(page.getByTestId("promotion-diagnostics-summary")).toBeVisible();
};

const promotionSnapshot = async () =>
  adminFixtureDatabase().billingPromotion.findUniqueOrThrow({
    where: { id: FIXTURE_PROMOTION.id },
    select: {
      redeemedCount: true,
      isActive: true,
      stripeCouponId: true,
      stripePromotionCodeId: true,
      appliesToPlanIds: true,
      updatedAt: true,
    },
  });

test.describe("promotion diagnostics", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("billing");
  });

  test("a configuration-only run needs no account and creates nothing", async ({
    page,
  }) => {
    const before = await promotionSnapshot();
    const redemptionsBefore =
      await adminFixtureDatabase().billingPromotionRedemption.count();
    const usersBefore = await adminFixtureDatabase().user.count();

    await openPromotions(page);
    // The account field is optional and starts empty: a configuration-only run
    // is the default, not an opt-in.
    await expect(page.getByTestId("promotion-diagnostics-user")).toHaveValue("");
    await runDiagnostics(page);

    await expect(page.getByTestId("promotion-diagnostics-local-policy")).toBeVisible();
    await expect(
      page.getByTestId("promotion-diagnostics-account")
    ).toHaveAttribute("data-status", "not_checked");
    await expect(
      page.getByTestId("promotion-diagnostics-account")
    ).toContainText("Not evaluated — no account selected");
    await expect(page.getByTestId("promotion-diagnostics-preview")).toBeVisible();
    await expect(page.getByTestId("promotion-diagnostics-actions")).toBeVisible();

    // Stripe is not configured on this harness, and the panel says so rather
    // than reporting a linkage it could not read.
    await expect(
      page.getByTestId("promotion-diagnostics-stripe")
    ).toHaveAttribute("data-status", "not_checked");
    await expect(
      page.getByTestId("promotion-diagnostics-check-stripe_linkage")
    ).toContainText("stripe_not_configured");

    // The abuse layer is always reported as not evaluated: the request that ran
    // this diagnosis came from the operator, not the customer.
    await expect(page.getByTestId("promotion-diagnostics-abuse")).toContainText(
      "the admin request's IP is not the customer's IP"
    );

    expect(await promotionSnapshot()).toEqual(before);
    expect(
      await adminFixtureDatabase().billingPromotionRedemption.count()
    ).toBe(redemptionsBefore);
    expect(await adminFixtureDatabase().user.count()).toBe(usersBefore);
  });

  test("an account-specific run reuses a seeded customer and reports already used", async ({
    page,
  }) => {
    // `disputedHold` already holds a redemption of the fixture promotion, which
    // is exactly the state a support question arrives in. No new account.
    const usersBefore = await adminFixtureDatabase().user.count();

    await openPromotions(page);
    await page
      .getByTestId("promotion-diagnostics-user")
      .fill(FIXTURE_CUSTOMERS.disputedHold.id);
    await runDiagnostics(page);

    await expect(
      page.getByTestId("promotion-diagnostics-summary")
    ).toHaveAttribute("data-status", "blocked");
    await expect(
      page.getByTestId("promotion-diagnostics-check-already_redeemed")
    ).toHaveAttribute("data-status", "fail");
    await expect(
      page.getByTestId("promotion-diagnostics-check-already_redeemed")
    ).toContainText("already_used");
    await expect(
      page.getByTestId(
        "promotion-diagnostics-action-account_state_blocks_checkout"
      )
    ).toBeVisible();

    expect(await adminFixtureDatabase().user.count()).toBe(usersBefore);
    expect(
      await adminFixtureDatabase().billingPromotionRedemption.count({
        where: {
          promotionId: FIXTURE_PROMOTION.id,
          userId: FIXTURE_CUSTOMERS.disputedHold.id,
        },
      })
    ).toBe(1);
  });

  test("a blocked policy names its own reason", async ({ page }) => {
    // The fixture promotion covers Pro only, so asking about Max is refused --
    // and the panel says which check refused it, not just that something did.
    await openPromotions(page);
    await page.getByTestId("promotion-diagnostics-plan").selectOption("max");
    await runDiagnostics(page);

    await expect(
      page.getByTestId("promotion-diagnostics-summary")
    ).toHaveAttribute("data-status", "blocked");
    await expect(
      page.getByTestId("promotion-diagnostics-check-selected_plan_eligibility")
    ).toContainText("plan_not_eligible");
  });

  test("an unsaved edit disables the run instead of answering about a stale row", async ({
    page,
  }) => {
    await openPromotions(page);
    await expect(page.getByTestId("promotion-diagnostics-run")).toBeEnabled();

    // Edit the promotion in the catalogue editor above without saving.
    await page
      .getByRole("textbox", { name: "Code", exact: true })
      .first()
      .fill(`${FIXTURE_PROMOTION.code}X`);

    await expect(
      page.getByTestId("promotion-diagnostics-dirty-notice")
    ).toBeVisible();
    await expect(
      page.getByTestId("promotion-diagnostics-dirty-notice")
    ).toContainText("Save or discard changes before diagnosing");
    await expect(page.getByTestId("promotion-diagnostics-run")).toBeDisabled();

    // And nothing was saved on the way past.
    expect((await promotionSnapshot()).appliesToPlanIds).toBe(
      JSON.stringify(["pro"])
    );
  });

  test("the result can be copied as a summary and as JSON", async ({ page }) => {
    await openPromotions(page);
    await runDiagnostics(page);
    await expect(
      page.getByTestId("promotion-diagnostics-copy-summary")
    ).toBeVisible();
    await expect(
      page.getByTestId("promotion-diagnostics-copy-json")
    ).toBeVisible();
  });

  test("the panel is operable from the keyboard and moves focus to the answer", async ({
    page,
  }) => {
    await openPromotions(page);
    const run = page.getByTestId("promotion-diagnostics-run");
    await run.focus();
    await expect(run).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("promotion-diagnostics-summary")).toBeVisible();
    // The results region takes focus so a keyboard operator lands on the answer
    // they asked for rather than at the top of the page.
    await expect(
      panel(page).locator('[aria-live="polite"][tabindex="-1"]')
    ).toBeFocused();
  });

  test("a failing request shows an error with a retry, and no stale result", async ({
    page,
  }) => {
    await openPromotions(page);
    await page.route("**/api/admin/billing/promotions/diagnose", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          code: "PROMOTION_DIAGNOSTICS_FAILED",
          error: "Promotion diagnostics could not be completed.",
        }),
      })
    );
    await page.getByTestId("promotion-diagnostics-run").click();
    const error = page.getByTestId("promotion-diagnostics-error");
    await expect(error).toBeVisible();
    await expect(
      page.getByTestId("promotion-diagnostics-summary")
    ).toHaveCount(0);
    await expect(error.getByRole("button", { name: "Retry" })).toBeVisible();

    await page.unroute("**/api/admin/billing/promotions/diagnose");
    await error.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByTestId("promotion-diagnostics-summary")).toBeVisible();
    await expect(page.getByTestId("promotion-diagnostics-error")).toHaveCount(0);
  });

  test("the panel does not overflow a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await openPromotions(page);
    await runDiagnostics(page);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("an operator without billing:write cannot run a diagnosis", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    const refused = await adminApi(page).post(
      "/api/admin/billing/promotions/diagnose",
      {
        promotionId: FIXTURE_PROMOTION.id,
        planId: "pro",
        billingInterval: "monthly",
      }
    );
    expect([403, 404]).toContain(refused.status());
  });

  test("each run records exactly one audit entry", async ({ page }) => {
    const before = await adminFixtureDatabase().adminAuditLog.count({
      where: { action: "promotion.diagnostics.executed" },
    });
    await openPromotions(page);
    await runDiagnostics(page);
    await expect
      .poll(async () =>
        adminFixtureDatabase().adminAuditLog.count({
          where: { action: "promotion.diagnostics.executed" },
        })
      )
      .toBe(before + 1);
  });

  test("a Stripe blocker names the field, not just the object", async ({
    page,
  }) => {
    // Stripe is unconfigured on this harness, so the linkage verdict is reached
    // by patching the real response rather than by standing up Stripe. What is
    // under test is the rendering: the panel printed drift from the start and
    // never printed the blocking reasons, which is backwards -- a check that
    // says `stored_coupon_mismatch` names the object but not the field, and the
    // field is what tells an operator whether to repair or replace.
    await page.route("**/api/admin/billing/promotions/diagnose", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.report.stripe = {
        ...body.report.stripe,
        status: "fail",
        checks: [
          { id: "stored_coupon", status: "fail", reason: "stored_coupon_mismatch" },
          { id: "stripe_mode", status: "pass", reason: null },
          { id: "product_restriction", status: "pass", reason: null },
        ],
        blockingReasons: ["identity:duration", "identity:metadata_promotion_id"],
        driftReasons: ["drift:expires_at"],
        facts: {
          expectLiveMode: true,
          storedCouponId: "cpn_stub_coupon",
          storedCouponExists: true,
          storedCouponMismatches: [
            "identity:duration",
            "identity:metadata_promotion_id",
          ],
          storedPromotionCodeId: "promo_stub_code",
          storedPromotionCodeExists: true,
          storedPromotionCodeMismatches: [],
          exactCodeCandidates: [
            {
              id: "promo_stub_stranger",
              active: true,
              livemode: true,
              mismatches: ["identity:metadata_promotion_id"],
              adoptable: false,
            },
          ],
          recommendation: "manual_review",
        },
      };
      await route.fulfill({ response, json: body });
    });

    await openPromotions(page);
    await runDiagnostics(page);

    const blocking = page.getByTestId("promotion-diagnostics-blocking-reasons");
    await expect(blocking).toBeVisible();
    await expect(blocking).toContainText("identity:duration");
    await expect(blocking).toContainText("identity:metadata_promotion_id");

    // The objects holding the code string are listed, with why each was refused.
    const candidates = page.getByTestId("promotion-diagnostics-candidates");
    await expect(candidates).toContainText("Active");
    await expect(candidates).toContainText("identity:metadata_promotion_id");

    // A Stripe object id stays masked until it is asked for, blocker or not.
    await expect(candidates).not.toContainText("promo_stub_stranger");
    await candidates
      .getByRole("button", { name: /^Reveal Active/ })
      .click();
    await expect(candidates).toContainText("promo_stub_stranger");
  });
});
