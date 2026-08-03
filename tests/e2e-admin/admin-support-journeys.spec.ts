import {
  ADMIN_E2E_IDENTITIES,
  FIXTURE_CUSTOMERS,
  FIXTURE_FEEDBACK,
  FIXTURE_PRIVACY_REQUEST,
  consoleHeading,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * The support operator's day: find a customer, open them, leave a record, and
 * move a case through its states.
 *
 * These are the `support:write` mutations, chosen because they are the ones a
 * support agent runs unattended many times a day -- a silent failure here is
 * invisible to everyone except the customer waiting for an answer.
 */

test.describe("support journeys", () => {
  test("searching for a customer leads to their detail page", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    await page.goto("/admin/users");

    // Search narrows the list to the matching account only.
    await page
      .getByPlaceholder("Search users by email, ID, name, or Stripe customer")
      .fill(FIXTURE_CUSTOMERS.disputedHold.email);
    await page.getByRole("button", { name: "Search", exact: true }).click();

    const link = page.getByRole("link", {
      name: `View details for ${FIXTURE_CUSTOMERS.disputedHold.email}`,
    });
    await expect(link).toBeVisible();
    await expect(
      page.getByRole("link", { name: /^View details for/ })
    ).toHaveCount(1);

    await link.click();
    await expect(page).toHaveURL(
      `/admin/users/${FIXTURE_CUSTOMERS.disputedHold.id}`
    );
    await expect(consoleHeading(page)).toHaveText("Customer detail");
    await expect(
      page.getByText(FIXTURE_CUSTOMERS.disputedHold.email)
    ).toBeVisible();
    // The billing risk that brought the operator here is on the page.
    await expect(
      page.getByText("Chargeback opened on the Power credit pack")
    ).toBeVisible();
  });

  test("a support note is saved against the customer and attributed", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    await page.goto(`/admin/users/${FIXTURE_CUSTOMERS.activePro.id}`);

    const notes = page.locator("section").filter({ hasText: "Internal notes" }).last();
    await expect(notes.getByText("No internal notes yet.")).toBeVisible();

    const saveNote = notes.getByRole("button", { name: "Save note" });
    // Empty is not submittable.
    await expect(saveNote).toBeDisabled();

    await notes
      .getByPlaceholder("Add context, follow-up, risk notes, or customer handling details")
      .fill("Customer confirmed the duplicate charge by email; refund queued.");
    await expect(saveNote).toBeEnabled();
    await saveNote.click();

    // The panel names the target type it wrote against, so the confirmation is
    // specific to this customer rather than a generic "saved".
    await expect(
      page.getByText("Admin note saved on this user.")
    ).toBeVisible();
    await expect(
      notes.getByText(
        "Customer confirmed the duplicate charge by email; refund queued."
      )
    ).toBeVisible();
    await expect(notes.getByText("No internal notes yet.")).toHaveCount(0);

    const stored = await adminFixtureDatabase().adminNote.findMany({
      where: { targetType: "User", targetId: FIXTURE_CUSTOMERS.activePro.id },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].createdByEmail).toBe(ADMIN_E2E_IDENTITIES.support.email);
  });

  test("feedback moves through its statuses and the change survives a reload", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    await page.goto("/admin/feedback");

    const entry = page
      .locator("article")
      .filter({ hasText: FIXTURE_FEEDBACK.open.message });
    // The current status is the one that cannot be re-selected.
    await expect(entry.getByRole("button", { name: "open", exact: true })).toBeDisabled();

    await entry.getByRole("button", { name: "reviewing", exact: true }).click();
    await expect(
      entry.getByRole("button", { name: "reviewing", exact: true })
    ).toBeDisabled();
    await expect(
      entry.getByRole("button", { name: "open", exact: true })
    ).toBeEnabled();

    await page.reload();
    const reloaded = page
      .locator("article")
      .filter({ hasText: FIXTURE_FEEDBACK.open.message });
    await expect(
      reloaded.getByRole("button", { name: "reviewing", exact: true })
    ).toBeDisabled();

    const stored = await adminFixtureDatabase().feedback.findUniqueOrThrow({
      where: { id: FIXTURE_FEEDBACK.open.id },
      select: { status: true },
    });
    expect(stored.status).toBe("reviewing");

    // The change is attributable: the route writes an audit entry for it.
    const audit = await adminFixtureDatabase().adminAuditLog.findMany({
      where: { targetType: "Feedback", targetId: FIXTURE_FEEDBACK.open.id },
      select: { action: true, actorEmail: true },
    });
    expect(audit.map((row) => row.action)).toContain("feedback.status.updated");
    expect(audit[0].actorEmail).toBe(ADMIN_E2E_IDENTITIES.support.email);
  });

  test("closing feedback goes through the completion dialog and records the outcome", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    await page.goto("/admin/feedback");

    const entry = page
      .locator("article")
      .filter({ hasText: FIXTURE_FEEDBACK.open.message });
    // The reporter opted into lifecycle emails; the console says so without
    // repeating the address.
    await expect(entry.getByTestId("feedback-notify-badge")).toHaveText(
      /Email updates on/
    );

    // Closing is never one click: the dialog collects the outcome and the
    // user-facing reply first.
    await entry.getByRole("button", { name: "resolved", exact: true }).click();
    const dialog = page.getByTestId("feedback-completion-dialog");
    await expect(dialog).toBeVisible();

    await page
      .getByTestId("feedback-completion-outcome")
      .selectOption("not_reproduced");
    const reply =
      "We could not reproduce this yet; please share the exact steps if it happens again.";
    await page.getByTestId("feedback-completion-reply").fill(reply);

    // The preview shows exactly what the reporter will be emailed -- the
    // neutral not-reproduced wording, never a fixed claim, plus the reply.
    const preview = page.getByTestId("feedback-completion-preview");
    await expect(preview).toContainText("could not reproduce");
    await expect(preview).toContainText(reply);
    await expect(preview).not.toContainText("has been fixed");

    await page.getByTestId("feedback-completion-confirm").click();
    await expect(dialog).toBeHidden();
    await expect(
      entry.getByRole("button", { name: "resolved", exact: true })
    ).toBeDisabled();

    const stored = await adminFixtureDatabase().feedback.findUniqueOrThrow({
      where: { id: FIXTURE_FEEDBACK.open.id },
      select: { status: true, closureOutcome: true, userReply: true },
    });
    expect(stored.status).toBe("resolved");
    expect(stored.closureOutcome).toBe("not_reproduced");
    expect(stored.userReply).toBe(reply);

    // The immutable completed event carries the snapshot the email renders
    // from, and the submitter notification is queued exactly once.
    const event = await adminFixtureDatabase().feedbackLifecycleEvent.findUniqueOrThrow(
      {
        where: {
          feedbackId_stage: {
            feedbackId: FIXTURE_FEEDBACK.open.id,
            stage: "completed",
          },
        },
      }
    );
    expect(event.outcomeCode).toBe("not_reproduced");
    expect(event.userReply).toBe(reply);

    const deliveries = await adminFixtureDatabase().notificationDelivery.findMany({
      where: {
        kind: "feedback_user_completed",
        referenceId: FIXTURE_FEEDBACK.open.id,
      },
    });
    expect(deliveries).toHaveLength(1);
  });

  test("a privacy request is progressed and the queue reflects the new status", async ({
    page,
    signInAs,
  }) => {
    await signInAs("support");
    await page.goto("/admin/support");

    const queue = page
      .locator("section")
      .filter({ hasText: "Data rights request queue" });
    const request = queue
      .locator("details")
      .filter({ hasText: FIXTURE_PRIVACY_REQUEST.open.email });
    await request.getByRole("group").or(request.locator("summary")).first().click();

    await request.getByRole("combobox").first().selectOption("in_progress");
    await request
      .getByPlaceholder("Operator note")
      .fill("Export bundle generated and delivered to the customer.");
    await request.getByRole("button", { name: "Save request" }).click();

    await expect(request.getByText("in_progress").first()).toBeVisible();

    const stored = await adminFixtureDatabase().privacyRequest.findUniqueOrThrow({
      where: { id: FIXTURE_PRIVACY_REQUEST.open.id },
      select: { status: true, note: true, handledByEmail: true },
    });
    expect(stored.status).toBe("in_progress");
    expect(stored.note).toBe(
      "Export bundle generated and delivered to the customer."
    );
    expect(stored.handledByEmail).toBe(ADMIN_E2E_IDENTITIES.support.email);
  });
});
