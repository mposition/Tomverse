import { expect, test, type Page } from "@playwright/test";

/**
 * What the admin console *says* happened, against what the API actually did.
 *
 * Mounting `AppToastViewport` in the console made every `dispatchAppToast()`
 * call visible for the first time. Copy that had never been read by anyone was
 * claiming more than the server delivered -- most sharply on refunds, where
 * four of the six possible Stripe outcomes move no money at all and all six
 * produced the same sentence.
 *
 * Every response here is controlled with network interception. Nothing on the
 * server is relaxed: the real `/api/admin/**` handlers keep their session,
 * permission, rate-limit, reauthentication and two-person approval checks.
 */

const FIXTURE = "/e2e/admin-console-fixture?view=toasts";
const REFUND_ID = "qa-refund-1";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const approvedRequest = (overrides: Record<string, unknown>) => ({
  success: true,
  refundRequest: {
    id: REFUND_ID,
    email: "customer@example.test",
    plan: "Pro",
    status: "approved",
    reason: "Charged after cancelling",
    adminNote: null,
    stripeCustomerId: "cus_qa",
    stripeSubscriptionId: "sub_qa",
    subscriptionStatus: "canceled",
    subscriptionBillingInterval: "monthly",
    subscriptionCurrentPeriodEnd: "2026-09-01T00:00:00.000Z",
    stripeRefundId: null,
    stripeRefundStatus: null,
    stripeChargeId: null,
    refundAmountCents: null,
    refundCurrency: null,
    requestedAt: "2026-07-30T09:00:00.000Z",
    reviewedAt: "2026-08-01T09:00:00.000Z",
    ...overrides,
  },
});

async function waitForHydration(page: Page, selector: string) {
  await page.waitForFunction((target) => {
    const element = document.querySelector(target);
    if (!element) return false;
    return Object.keys(element).some((key) => key.startsWith("__reactFiber$"));
  }, selector);
}

async function openFixture(page: Page) {
  // The notes box fetches on mount; answering it keeps its load failure out of
  // the toast the test is about.
  await page.route(
    (url) => url.pathname === "/api/admin/notes",
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill(json({ notes: [] }))
        : route.fallback()
  );
  const response = await page.goto(FIXTURE);
  expect(response?.status()).toBeLessThan(400);
  await expect(
    page.getByRole("button", { name: "Approve", exact: true }).first()
  ).toBeVisible();
  await waitForHydration(page, '[data-testid="app-toast-viewport"]');
}

async function approveRefund(page: Page, response: unknown, status = 200) {
  await page.route(
    (url) => url.pathname === `/api/admin/refund-requests/${REFUND_ID}`,
    (route) => route.fulfill(json(response, status))
  );
  await page.getByRole("button", { name: "Approve", exact: true }).first().click();
}

// ---------------------------------------------------------------------------
// Refunds: the sentence has to match what Stripe did
// ---------------------------------------------------------------------------

test("a completed Stripe refund is confirmed as a completed refund", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(
    page,
    approvedRequest({
      stripeRefundId: "re_qa",
      stripeRefundStatus: "succeeded",
      refundAmountCents: 2_000,
      refundCurrency: "USD",
    })
  );

  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "success");
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toContainText("reset to Free");
  await expect(toast).toContainText("Stripe refunded");
});

test("an approval that refunded nothing says so, and is not a plain success", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(
    page,
    approvedRequest({ stripeRefundStatus: "no_payment_intent" })
  );

  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  // Not "success": the request was approved, but no money moved.
  await expect(toast).toHaveAttribute("data-tone", "info");
  await expect(toast).toContainText("No Stripe payment was found");
  await expect(toast).not.toContainText("Stripe refunded");
  // The part that did happen is still stated.
  await expect(toast).toContainText("reset to Free");
});

test("a charge that was already refunded is not reported as a new refund", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(
    page,
    approvedRequest({ stripeRefundStatus: "already_refunded" })
  );

  const toast = page.getByTestId("app-toast");
  await expect(toast).toHaveAttribute("data-tone", "info");
  await expect(toast).toContainText("already refunded");
});

test("the refund row shows the same Stripe status the toast reports", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(
    page,
    approvedRequest({ stripeRefundStatus: "no_payment_intent" })
  );
  await expect(page.getByTestId("app-toast")).toBeVisible();

  // A financial outcome must survive the toast auto-dismissing. The row leaves
  // the pending filter once it is approved, so it is read where it now lives.
  await page.getByRole("button", { name: /^Approved/ }).click();
  await expect(
    page.getByText("Refund status: no_payment_intent")
  ).toBeVisible();
});

test("a two-person approval requirement reads as pending, not as a failure", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(
    page,
    {
      error: "A second administrator must approve this action.",
      code: "ADMIN_APPROVAL_REQUIRED",
      approvalId: "apr_qa_1",
    },
    409
  );

  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "info");
  await expect(toast).toHaveAttribute("role", "status");
  await expect(toast).toHaveAttribute("aria-live", "polite");
  await expect(toast).toContainText("apr_qa_1");
  await expect(toast).toContainText(/nothing has changed yet/i);
});

test("a reauthentication requirement is an assertive error with a next step", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(
    page,
    {
      error: "Sign in again before performing this high-risk administrator action.",
      code: "ADMIN_REAUTHENTICATION_REQUIRED",
    },
    428
  );

  const toast = page.getByTestId("app-toast");
  await expect(toast).toHaveAttribute("data-tone", "error");
  await expect(toast).toHaveAttribute("role", "alert");
  await expect(toast).toHaveAttribute("aria-live", "assertive");
  await expect(toast).toContainText(/sign in again/i);
});

test("a server error names no internal detail and tells the operator what to do", async ({
  page,
}) => {
  await openFixture(page);
  await approveRefund(page, "<html><body>502</body></html>", 500);

  const toast = page.getByTestId("app-toast");
  await expect(toast).toHaveAttribute("data-tone", "error");
  await expect(toast).toContainText("The refund request was not updated.");
  await expect(toast).toContainText("500");
  await expect(toast).not.toContainText("<html");
});

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

test("saving a note names what it was attached to", async ({ page }) => {
  await openFixture(page);
  await page.route(
    (url) => url.pathname === "/api/admin/notes",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill(
            json({
              note: {
                id: "note-1",
                targetType: "User",
                targetId: "qa-target-user",
                body: "Checked the charge with Stripe.",
                authorEmail: "qa@tomverse.app",
                createdAt: "2026-08-01T09:00:00.000Z",
              },
            })
          )
        : route.fulfill(json({ notes: [] }))
  );

  await page.getByPlaceholder(/Add context/i).fill("Checked the charge with Stripe.");
  await page.getByRole("button", { name: "Save note" }).click();

  const toast = page.getByTestId("app-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toHaveAttribute("data-tone", "success");
  await expect(toast).toContainText("Admin note saved on this user.");
});

test("a note that failed to save says the text was kept", async ({ page }) => {
  await openFixture(page);
  await page.route(
    (url) => url.pathname === "/api/admin/notes",
    (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 500, contentType: "text/html", body: "<html>500</html>" })
        : route.fulfill(json({ notes: [] }))
  );

  const draft = "Checked the charge with Stripe.";
  await page.getByPlaceholder(/Add context/i).fill(draft);
  await page.getByRole("button", { name: "Save note" }).click();

  const toast = page.getByTestId("app-toast");
  await expect(toast).toHaveAttribute("data-tone", "error");
  await expect(toast).toContainText(/still in the box/i);
  // And it really is: a failed save must not clear the operator's text.
  await expect(page.getByPlaceholder(/Add context/i)).toHaveValue(draft);
});
