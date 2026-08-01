import {
  FIXTURE_CUSTOMERS,
  adminApi,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * Account-recovery eligibility, asserted in the browser on the real
 * `/admin/users/:id` route.
 *
 * "Cancel deletion & restore account" is the console's recovery action. Whether
 * it is on offer is decided by `AdminUserSecurityControls`
 * (`accountStatus === "pending_deletion"`), whether it can be submitted is
 * decided by `validateAdminSecurityAction()` in `lib/adminUserSecurityCore.ts`
 * (an audit reason plus a support-ticket reference), and whether it is allowed
 * at all is decided by `hasAdminPermission()` in the route handler.
 *
 * Those three modules have unit tests. What they cannot show is whether the
 * decision reaches the screen: whether the control is actually rendered for an
 * eligible account and actually absent for an ineligible one, whether a
 * blocked click really sends no request, and whether the account state after a
 * successful recovery is what the operator was told it would be. Every case
 * below therefore drives the rendered control and, where a request must not
 * happen, counts the requests the page makes.
 */

const SECURITY_ENDPOINT = /\/api\/admin\/users\/[^/]+\/security$/;

/** Counts the recovery requests the page issues, so "sent nothing" is provable. */
const countSecurityRequests = (page: import("@playwright/test").Page) => {
  const seen: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && SECURITY_ENDPOINT.test(request.url())) {
      seen.push(request.postData() || "");
    }
  });
  return seen;
};

test.describe("account recovery eligibility", () => {
  test("an eligible account offers recovery and the administrator can complete it", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}`);

    // Eligible: deletion is scheduled, so the restore group is on screen.
    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account pending_deletion");
    await expect(
      page.getByTestId("admin-security-deletion-schedule")
    ).toBeVisible();
    const restore = page.getByTestId("admin-security-restore");
    await expect(restore).toBeVisible();
    await expect(restore).toBeEnabled();

    const requests = countSecurityRequests(page);
    await page.getByTestId("admin-security-reason").fill(
      "Customer withdrew the deletion request on the phone."
    );
    await page.getByTestId("admin-security-ticket").fill("TOMV-4821");

    const [response] = await Promise.all([
      page.waitForResponse(
        (candidate) =>
          SECURITY_ENDPOINT.test(candidate.url()) &&
          candidate.request().method() === "POST"
      ),
      restore.click(),
    ]);
    expect(response.status()).toBe(200);

    // The payload carries the operator's inputs and, per
    // buildAdminSecurityActionPayload, no expiry for restore_account.
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0])).toMatchObject({
      action: "restore_account",
      reason: "Customer withdrew the deletion request on the phone.",
      supportTicketReference: "TOMV-4821",
      until: null,
    });

    // Success UI, then the follow-on state: the account is active and the
    // recovery control is no longer eligible to be offered.
    await expect(
      page.getByText(
        "Scheduled deletion cancelled and the account restored. Automatic subscription renewal stays off."
      )
    ).toBeVisible();
    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account active");
    await expect(page.getByTestId("admin-security-restore")).toHaveCount(0);
    await expect(
      page.getByTestId("admin-security-deletion-schedule")
    ).toHaveCount(0);

    // And in the database, which is what the customer actually experiences.
    const user = await adminFixtureDatabase().user.findUniqueOrThrow({
      where: { id: FIXTURE_CUSTOMERS.pendingDeletion.id },
      select: { accountStatus: true, accountDeletionScheduledFor: true },
    });
    expect(user.accountStatus).toBe("active");
    expect(user.accountDeletionScheduledFor).toBeNull();
  });

  test("an active account is not offered recovery at all", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);

    await expect(page.getByTestId("admin-user-security-controls")).toBeVisible();
    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account active");
    // Ineligible, and the reason is on screen: there is nothing to restore, so
    // no restore group and no deletion schedule notice.
    await expect(page.getByTestId("admin-security-restore-group")).toHaveCount(0);
    await expect(page.getByTestId("admin-security-restore")).toHaveCount(0);
    await expect(
      page.getByTestId("admin-security-deletion-schedule")
    ).toHaveCount(0);
    // The controls that do apply to an active account are still there.
    await expect(page.getByTestId("admin-security-suspend")).toBeVisible();
  });

  test("a suspended account is not offered recovery either, only unsuspension", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.suspended.id}`);

    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account suspended");
    await expect(page.getByTestId("admin-security-restore-group")).toHaveCount(0);
    await expect(page.getByTestId("admin-security-suspend")).toHaveText(
      "Unsuspend account"
    );
    // The suspension reason is the state explanation the operator needs.
    await expect(page.getByText("Confirmed payment fraud")).toBeVisible();
  });

  test("recovery is refused, and no request is sent, until the required fields are filled", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}`);
    const requests = countSecurityRequests(page);
    const restore = page.getByTestId("admin-security-restore");

    // Nothing filled in: the audit reason is the first blocker.
    await restore.click();
    await expect(page.getByTestId("admin-security-reason-error")).toHaveText(
      "Enter an audit reason of at least 5 characters."
    );
    await expect(page.getByTestId("admin-security-reason")).toBeFocused();
    expect(requests).toHaveLength(0);

    // Reason supplied, ticket still missing: the second blocker, on its own field.
    await page
      .getByTestId("admin-security-reason")
      .fill("Customer asked us to keep the account.");
    await restore.click();
    await expect(page.getByTestId("admin-security-ticket-error")).toHaveText(
      "Enter the support ticket reference (at least 3 characters) that authorises this restoration."
    );
    await expect(page.getByTestId("admin-security-ticket")).toBeFocused();
    expect(requests).toHaveLength(0);

    // Both supplied: it goes through.
    await page.getByTestId("admin-security-ticket").fill("TOMV-9001");
    await restore.click();
    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account active");
    expect(requests).toHaveLength(1);
  });

  test("a role without the permission is refused by the server, and the console says so", async ({
    page,
    signInAs,
  }) => {
    // billing has neither support:write nor ops:write, which is what
    // /api/admin/users/:id/security requires for restore_account.
    await signInAs("billing");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}`);

    await page
      .getByTestId("admin-security-reason")
      .fill("Billing should not be able to restore an account.");
    await page.getByTestId("admin-security-ticket").fill("TOMV-7777");
    await page.getByTestId("admin-security-restore").click();

    await expect(page.getByTestId("admin-security-request-error")).toBeVisible();
    // The account is unchanged.
    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account pending_deletion");
    const user = await adminFixtureDatabase().user.findUniqueOrThrow({
      where: { id: FIXTURE_CUSTOMERS.pendingDeletion.id },
      select: { accountStatus: true },
    });
    expect(user.accountStatus).toBe("pending_deletion");
  });

  test("a stale administrator sign-in blocks recovery with a re-authentication route out", async ({
    page,
    signInAs,
  }) => {
    // Inside the 8-hour console window but past the 30-minute step-up window,
    // so the console renders and the mutation is refused with 428.
    await signInAs("owner", { authenticatedMinutesAgo: 45 });
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}`);

    await page
      .getByTestId("admin-security-reason")
      .fill("Attempting recovery on a stale administrator session.");
    await page.getByTestId("admin-security-ticket").fill("TOMV-5150");
    await page.getByTestId("admin-security-restore").click();

    const failure = page.getByTestId("admin-security-request-error");
    await expect(failure).toContainText(
      "Your administrator sign-in is no longer recent enough for this control."
    );
    await expect(
      page.getByTestId("admin-security-reauthenticate-link")
    ).toHaveAttribute(
      "href",
      `/auth/admin-reauthenticate?callbackUrl=${encodeURIComponent(
        `/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}`
      )}`
    );
    await expect(
      page.getByTestId("admin-security-account-status")
    ).toHaveText("Account pending_deletion");
  });

  test("eligibility that disappears mid-session is refused by the server", async ({
    page,
    signInAs,
  }) => {
    await signInAs("owner");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}`);
    await expect(page.getByTestId("admin-security-restore")).toBeVisible();

    // A second operator completes the recovery while this page is still open,
    // so the control on screen is now offering something that no longer applies.
    const api = adminApi(page);
    const raced = await api.post(
      `/api/admin/users/${FIXTURE_CUSTOMERS.pendingDeletion.id}/security`,
      {
        action: "restore_account",
        reason: "Restored by another operator first.",
        supportTicketReference: "TOMV-1111",
        until: null,
        incidentNote: null,
        provider: null,
      }
    );
    expect(raced.status()).toBe(200);

    await page
      .getByTestId("admin-security-reason")
      .fill("Second attempt after the account was already restored.");
    await page.getByTestId("admin-security-ticket").fill("TOMV-2222");
    await page.getByTestId("admin-security-restore").click();

    // The server reports the no-op rather than pretending it fixed something,
    // and the stale control re-renders as ineligible.
    await expect(
      page.getByText("This account was already active, so no change was made.")
    ).toBeVisible();
    await expect(page.getByTestId("admin-security-restore")).toHaveCount(0);
  });
});
