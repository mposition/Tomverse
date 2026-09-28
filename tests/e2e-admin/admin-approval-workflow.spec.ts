import {
  FIXTURE_CUSTOMERS,
  consoleHeading,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * High-risk admin actions execute for the administrator who submits them.
 *
 * Plan adjustment is the console's "plan recovery" lever. A second
 * administrator is not a queue: the save applies the plan, and the audit log
 * is the record. The confirmation phrase and the reason stay.
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

test.describe("high-risk admin actions", () => {
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

  test("a high-risk plan change is applied by the administrator who submits it", async ({
    page,
    signInAs,
  }) => {
    const database = adminFixtureDatabase();

    await signInAs("billing");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);
    const section = await fillPlanAdjustment(page, {
      plan: "Max",
      reason: REASON,
      confirm: "ADJUST PLAN",
    });
    await section.getByRole("button", { name: "Save", exact: true }).click();

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
    expect(await database.adminActionApproval.count()).toBe(0);
    await expect(page.getByText("Max", { exact: true }).first()).toBeVisible();

    await page.goto("/admin/audit");
    await expect(
      page
        .getByRole("cell", {
          name: `Adjusted plan for ${FIXTURE_CUSTOMERS.activePro.email} to Max.`,
        })
        .first()
    ).toBeVisible();
    const audit = await database.adminAuditLog.findMany({
      where: { targetType: "User", targetId: FIXTURE_CUSTOMERS.activePro.id },
      select: { action: true },
    });
    expect(audit.map((row) => row.action)).toContain("user.plan_adjusted");
  });

  test("a jurisdiction policy draft is activated by the administrator who submits it", async ({
    page,
    signInAs,
  }) => {
    const database = adminFixtureDatabase();

    await signInAs("owner");
    await page.goto("/admin/email-policy");
    await expect(consoleHeading(page)).toHaveText("Email policy");

    // 1. Seeding is ordinary work: it needs no approval, because a draft
    //    changes nothing about what is sent.
    await page.getByTestId("email-policy-create-draft").click();
    await expect
      .poll(async () => database.emailPolicyVersion.count())
      .toBe(1);
    const draft = await database.emailPolicyVersion.findFirstOrThrow();
    expect(draft.status).toBe("draft");
    expect(draft.approvedAt).toBeNull();
    // Nine since 2026-09-14: Switzerland left the EU profile for its own, on
    // Swiss UWG art. 3(1)(o) rather than the ePrivacy Directive
    // (docs/policy/email-eea-marketing-review-2026-09-14.md section 4.5). The
    // literal is asserted rather than read off the seed, because a test that
    // reads the same constant the code does cannot notice the count changing.
    expect(await database.jurisdictionProfile.count()).toBe(9);
    expect(
      await database.jurisdictionProfile.count({ where: { profileKey: "CH" } })
    ).toBe(1);

    await expect(page.getByTestId("email-policy-profile-KR")).toBeVisible();
    await page
      .getByLabel("Why this version is being activated")
      .fill("Launching the jurisdiction profiles researched on 2026-08-21.");
    await page.getByTestId("email-policy-activate").click();

    await expect
      .poll(async () =>
        (
          await database.emailPolicyVersion.findUniqueOrThrow({
            where: { id: draft.id },
            select: { status: true },
          })
        ).status
      )
      .toBe("active");
    expect(await database.adminActionApproval.count()).toBe(0);
  });
});
