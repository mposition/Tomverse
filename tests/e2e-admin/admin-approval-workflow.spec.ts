import {
  ADMIN_E2E_IDENTITIES,
  FIXTURE_CUSTOMERS,
  adminApi,
  consoleHeading,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * Two-person approval, end to end, using manual plan adjustment as the
 * representative high-risk action.
 *
 * Plan adjustment is the console's "plan recovery" lever -- the panel says so:
 * "Use only for billing support recovery" -- and it is the clearest example of
 * the approval contract, because `runWithAdminApproval()` binds the approval to
 * a hash of the exact request body. That is what makes this a journey rather
 * than a unit: the requester has to navigate away to the approvals queue, come
 * back, and re-send a byte-identical body. A regression that folds a
 * clock-derived value into the payload passes every unit test and makes the
 * workflow impossible to finish in a browser, which is exactly what happened
 * before `buildPlanAdjustPayload()` existed.
 */

const REASON = "Compensating a billing outage for this customer.";

const fillPlanAdjustment = async (
  page: import("@playwright/test").Page,
  { plan, reason, confirm }: { plan: string; reason: string; confirm: string }
) => {
  // `.last()` because the workspace wraps panels in sections: the outer
  // container matches the same text filter as the panel itself.
  const section = page
    .locator("section")
    .filter({ hasText: "Manual plan adjustment" })
    .last();
  await section.getByRole("combobox").selectOption(plan);
  await section.getByPlaceholder("Reason for audit log").fill(reason);
  await section.getByPlaceholder("ADJUST PLAN").fill(confirm);
  return section;
};

test.describe("two-person approval", () => {
  test("the save button stays locked until the reason and confirmation phrase are complete", async ({
    page,
    signInAs,
  }) => {
    await signInAs("billing");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);

    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        request.url().includes("/plan-adjust")
      ) {
        requests.push(request.postData() || "");
      }
    });

    const section = page
      .locator("section")
      .filter({ hasText: "Manual plan adjustment" })
      .last();
    // `exact` matters: the customer detail page also carries a "Save note".
    const save = section.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();

    // Reason alone is not enough.
    await section.getByPlaceholder("Reason for audit log").fill(REASON);
    await expect(save).toBeDisabled();

    // Nor is a confirmation phrase that only looks right.
    await section.getByPlaceholder("ADJUST PLAN").fill("adjust plan");
    await expect(save).toBeDisabled();

    await section.getByPlaceholder("ADJUST PLAN").fill("ADJUST PLAN");
    await expect(save).toBeEnabled();

    // Nothing was sent while it was disabled.
    expect(requests).toHaveLength(0);
  });

  test("a high-risk plan change is queued for approval, approved by a second administrator, and only then applied", async ({
    page,
    signInAs,
  }) => {
    const database = adminFixtureDatabase();

    // 1. The requester submits. The action is queued, not executed.
    await signInAs("billing");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);
    const section = await fillPlanAdjustment(page, {
      plan: "Max",
      reason: REASON,
      confirm: "ADJUST PLAN",
    });
    await section.getByRole("button", { name: "Save", exact: true }).click();

    await expect(
      page.getByText(/another authorized administrator/i)
    ).toBeVisible();
    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: FIXTURE_CUSTOMERS.activePro.id },
          select: { plan: true },
        })
      ).plan
    ).toBe(FIXTURE_CUSTOMERS.activePro.plan);

    const approval = await database.adminActionApproval.findFirstOrThrow({
      where: { action: "user.plan_adjust" },
    });
    expect(approval.status).toBe("pending");
    expect(approval.requestedByEmail).toBe(ADMIN_E2E_IDENTITIES.billing.email);

    // 2. The requester cannot approve their own request.
    const selfApproval = await adminApi(page).post("/api/admin/approvals", {
      approvalId: approval.id,
      decision: "approve",
    });
    expect(selfApproval.ok()).toBe(false);
    expect(
      (
        await database.adminActionApproval.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status
    ).toBe("pending");

    // 3. A second administrator approves it from the queue.
    await signInAs("approver");
    await page.goto("/admin/approvals");
    await expect(consoleHeading(page)).toHaveText("Approvals");
    const queued = page
      .locator("article, li")
      .filter({ hasText: "user.plan_adjust" })
      .first();
    await expect(queued).toBeVisible();
    await expect(queued.getByText(REASON)).toBeVisible();
    await queued.getByRole("button", { name: "Approve" }).click();

    await expect
      .poll(async () =>
        (
          await database.adminActionApproval.findUniqueOrThrow({
            where: { id: approval.id },
          })
        ).status
      )
      .toBe("approved");
    // Approval alone does not change the customer.
    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: FIXTURE_CUSTOMERS.activePro.id },
          select: { plan: true },
        })
      ).plan
    ).toBe(FIXTURE_CUSTOMERS.activePro.plan);

    // 4. The requester re-sends the identical request, which now executes.
    await signInAs("billing");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);
    const retry = await fillPlanAdjustment(page, {
      plan: "Max",
      reason: REASON,
      confirm: "ADJUST PLAN",
    });
    await retry.getByRole("button", { name: "Save", exact: true }).click();

    await expect
      .poll(async () =>
        (
          await database.user.findUniqueOrThrow({
            where: { id: FIXTURE_CUSTOMERS.activePro.id },
            select: { plan: true },
          })
        ).plan
      )
      .toBe("Max");
    expect(
      (
        await database.adminActionApproval.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status
    ).toBe("consumed");

    // 5. The change is on screen and in the audit log.
    await expect(page.getByText("Max", { exact: true }).first()).toBeVisible();
    await page.goto("/admin/audit");
    await expect(
      page.getByText(
        `Adjusted plan for ${FIXTURE_CUSTOMERS.activePro.email} to Max.`
      )
    ).toBeVisible();
    const audit = await database.adminAuditLog.findMany({
      where: { targetType: "User", targetId: FIXTURE_CUSTOMERS.activePro.id },
      select: { action: true },
    });
    expect(audit.map((row) => row.action)).toContain("user.plan_adjusted");
    const approvalAudit = await database.adminAuditLog.findMany({
      where: { targetType: "AdminActionApproval" },
      select: { action: true },
    });
    expect(approvalAudit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "admin_approval.requested",
        "admin_approval.consumed",
      ])
    );
  });

  test("a rejected approval leaves the customer untouched", async ({
    page,
    signInAs,
  }) => {
    const database = adminFixtureDatabase();

    await signInAs("billing");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);
    const section = await fillPlanAdjustment(page, {
      plan: "Free",
      reason: "Downgrade requested by the customer.",
      confirm: "ADJUST PLAN",
    });
    await section.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText(/another authorized administrator/i)
    ).toBeVisible();

    await signInAs("approver");
    await page.goto("/admin/approvals");
    await page
      .locator("article, li")
      .filter({ hasText: "user.plan_adjust" })
      .first()
      .getByRole("button", { name: "Reject" })
      .click();

    await expect
      .poll(async () =>
        (
          await database.adminActionApproval.findFirstOrThrow({
            where: { action: "user.plan_adjust" },
          })
        ).status
      )
      .toBe("rejected");
    expect(
      (
        await database.user.findUniqueOrThrow({
          where: { id: FIXTURE_CUSTOMERS.activePro.id },
          select: { plan: true },
        })
      ).plan
    ).toBe(FIXTURE_CUSTOMERS.activePro.plan);
  });
});
