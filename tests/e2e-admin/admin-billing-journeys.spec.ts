import {
  ADMIN_E2E_IDENTITIES,
  FIXTURE_PROMOTION,
  FIXTURE_REFUNDS,
  adminApi,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * The `billing:write` journeys: reviewing a refund and editing the promotion
 * catalogue.
 *
 * These are the highest-consequence non-approval mutations in the console --
 * one moves money, the other changes what every future checkout is charged --
 * so both success and refusal are asserted, together with the state the
 * operator is left looking at.
 *
 * Stripe is deliberately unconfigured on the harness server, so
 * `isStripeConfigured()` is false and the refund route takes its documented
 * no-Stripe path. Nothing here can reach a payment processor.
 */

const refundCard = (page: import("@playwright/test").Page, reason: string) =>
  page.locator("article").filter({ hasText: reason });

/**
 * Saves the promotion catalogue. Any dirty change makes the panel ask for an
 * explicit publish confirmation first -- "Checkout uses these values
 * immediately" -- so a save is a two-step action, and the test performs both.
 */
const savePromotions = async (page: import("@playwright/test").Page) => {
  // The panel header's save is the one that asks for confirmation; the
  // catalogue footer carries a second, direct save.
  await page.getByRole("button", { name: "Save to DB" }).first().click();
  await expect(
    page.getByText("Review before publishing billing changes")
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish changes" }).click();
};

test.describe("billing journeys", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("billing");
  });

  test("approving a refund is blocked until the credit review is acknowledged", async ({
    page,
  }) => {
    await page.goto("/admin/refunds");
    const card = refundCard(page, FIXTURE_REFUNDS.pending.reason);
    const approve = card.getByRole("button", { name: "Approve" });

    // The customer holds a credit-pack purchase, so the console requires an
    // explicit acknowledgement before the money moves.
    await expect(
      card.getByText("Credit balance and cost review required")
    ).toBeVisible();
    await expect(approve).toBeDisabled();

    // A disabled control must not reach the server. Prove it by asking the
    // server directly with the same body the console would send.
    const withoutConfirmation = await adminApi(page).patch(
      `/api/admin/refund-requests/${FIXTURE_REFUNDS.pending.id}`,
      { action: "approve" }
    );
    expect(withoutConfirmation.status()).toBe(400);
    expect(await withoutConfirmation.json()).toMatchObject({
      error:
        "Review the purchased credit balance and consumed AI cost before approving this refund.",
    });
    expect(
      (
        await adminFixtureDatabase().refundRequest.findUniqueOrThrow({
          where: { id: FIXTURE_REFUNDS.pending.id },
          select: { status: true },
        })
      ).status
    ).toBe("pending");

    await card
      .getByLabel(
        "I reviewed purchased credit balance, used credits, and funded AI cost."
      )
      .check();
    await expect(approve).toBeEnabled();
  });

  test("an acknowledged refund is approved, recorded, and leaves the pending queue", async ({
    page,
  }) => {
    await page.goto("/admin/refunds");
    const card = refundCard(page, FIXTURE_REFUNDS.pending.reason);

    await card
      .getByPlaceholder("Optional note for the customer email")
      .fill("Duplicate annual charge confirmed with the customer.");
    await card
      .getByLabel(
        "I reviewed purchased credit balance, used credits, and funded AI cost."
      )
      .check();
    await card.getByRole("button", { name: "Approve" }).click();

    // Success UI: the queue counters move and the request leaves the pending
    // filter the panel opens on.
    await expect(page.getByRole("button", { name: "Pending 0" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Approved 2" })).toBeVisible();
    await expect(card).toHaveCount(0);

    // Under "All" it is back, now carrying the reviewer's timeline entry.
    await page.getByRole("button", { name: "All 2" }).click();
    const reviewed = refundCard(page, FIXTURE_REFUNDS.pending.reason);
    await expect(
      reviewed.getByText(
        "Refund request approved. User membership was reset to Free."
      )
    ).toBeVisible();
    await expect(
      reviewed.getByText(ADMIN_E2E_IDENTITIES.billing.email).first()
    ).toBeVisible();
    await expect(
      reviewed.getByText("Duplicate annual charge confirmed with the customer.")
    ).toBeVisible();

    const stored = await adminFixtureDatabase().refundRequest.findUniqueOrThrow({
      where: { id: FIXTURE_REFUNDS.pending.id },
      select: {
        status: true,
        adminNote: true,
        reviewedByUserId: true,
        timelineEvents: { select: { eventType: true, actorEmail: true } },
      },
    });
    expect(stored.status).toBe("approved");
    expect(stored.adminNote).toBe(
      "Duplicate annual charge confirmed with the customer."
    );
    expect(stored.reviewedByUserId).toBe(ADMIN_E2E_IDENTITIES.billing.id);
    expect(stored.timelineEvents.map((event) => event.eventType)).toContain(
      "approved"
    );
  });

  test("a refund can be rejected without any credit acknowledgement", async ({
    page,
  }) => {
    await page.goto("/admin/refunds");
    const card = refundCard(page, FIXTURE_REFUNDS.pending.reason);

    await card
      .getByPlaceholder("Optional note for the customer email")
      .fill("Outside the refund window; offered a plan downgrade instead.");
    // Reject is available even while Approve is still gated.
    await expect(card.getByRole("button", { name: "Approve" })).toBeDisabled();
    await card.getByRole("button", { name: "Reject" }).click();

    await expect(page.getByRole("button", { name: "Rejected 1" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pending 0" })).toBeVisible();

    const stored = await adminFixtureDatabase().refundRequest.findUniqueOrThrow({
      where: { id: FIXTURE_REFUNDS.pending.id },
      select: { status: true, adminNote: true },
    });
    expect(stored.status).toBe("rejected");
    expect(stored.adminNote).toBe(
      "Outside the refund window; offered a plan downgrade instead."
    );
  });

  test("a reviewed refund cannot be reviewed a second time", async ({ page }) => {
    await page.goto("/admin/refunds");
    const api = adminApi(page);

    const first = await api.patch(
      `/api/admin/refund-requests/${FIXTURE_REFUNDS.pending.id}`,
      { action: "reject", adminNote: "First decision." }
    );
    expect(first.ok()).toBe(true);

    const second = await api.patch(
      `/api/admin/refund-requests/${FIXTURE_REFUNDS.pending.id}`,
      { action: "approve", confirmCreditReview: true }
    );
    expect(second.status()).toBe(409);
    expect(await second.json()).toMatchObject({
      error: "Refund request has already been reviewed.",
    });
    expect(
      (
        await adminFixtureDatabase().refundRequest.findUniqueOrThrow({
          where: { id: FIXTURE_REFUNDS.pending.id },
          select: { status: true },
        })
      ).status
    ).toBe("rejected");
  });

  test("a promotion change is saved to the database and survives a reload", async ({
    page,
  }) => {
    await page.goto("/admin/promotions");
    const promotion = page
      .locator("article")
      .filter({ hasText: FIXTURE_PROMOTION.code });

    await expect(promotion.getByLabel("Discount percent")).toHaveValue(
      String(FIXTURE_PROMOTION.discountPercent)
    );
    await promotion.getByLabel("Discount percent").fill("45");
    await savePromotions(page);

    await expect(page.getByText("Billing settings saved to DB.")).toBeVisible();
    expect(
      (
        await adminFixtureDatabase().billingPromotion.findUniqueOrThrow({
          where: { code: FIXTURE_PROMOTION.code },
          select: { discountPercent: true },
        })
      ).discountPercent
    ).toBe(45);

    await page.reload();
    await expect(
      page
        .locator("article")
        .filter({ hasText: FIXTURE_PROMOTION.code })
        .getByLabel("Discount percent")
    ).toHaveValue("45");
  });

  test("a promotion with no discount at all is refused and nothing is written", async ({
    page,
  }) => {
    await page.goto("/admin/promotions");
    const promotion = page
      .locator("article")
      .filter({ hasText: FIXTURE_PROMOTION.code });

    // Neither a percentage nor a fixed amount: the server-side rule in
    // `promotionSchema` refuses the whole save.
    await promotion.getByLabel("Discount percent").fill("0");
    await savePromotions(page);

    await expect(
      page.getByText("Failed to save billing settings.")
    ).toBeVisible();
    // The stored promotion is untouched, so a rejected save cannot half-apply.
    expect(
      (
        await adminFixtureDatabase().billingPromotion.findUniqueOrThrow({
          where: { code: FIXTURE_PROMOTION.code },
          select: { discountPercent: true },
        })
      ).discountPercent
    ).toBe(FIXTURE_PROMOTION.discountPercent);
  });
});
