import {
  ADMIN_E2E_IDENTITIES,
  FIXTURE_APP_SETTINGS,
  FIXTURE_INCIDENT,
  FIXTURE_MODEL,
  FIXTURE_NOTIFICATION,
  FIXTURE_WEBHOOK,
  adminApi,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";

/**
 * The `ops:write` journeys: provider incidents, the model registry, platform
 * settings, alert handling, webhook replay, and retention cleanup.
 *
 * One representative mutation per operational risk category, chosen for what a
 * failure would cost: an incident that will not open leaves customers on a
 * broken provider, a model status that will not change leaves a failing model
 * selectable, a kill switch that will not save leaves an outage running, and a
 * cleanup that runs without its confirmation deletes customer data.
 */

test.describe("platform operations", () => {
  test.beforeEach(async ({ signInAs }) => {
    await signInAs("ops");
  });

  test("an incident cannot be opened without a title and is refused client-side", async ({
    page,
  }) => {
    await page.goto("/admin/providers?tab=incidents");
    const enable = page.getByRole("button", { name: "Enable incident mode" });

    await expect(enable).toBeDisabled();
    await page
      .getByPlaceholder("Provider outage, quota issue, degraded model")
      .fill("E2E incident opened from the console");
    await expect(enable).toBeEnabled();
  });

  test("opening and resolving a provider incident is reflected on screen and stored", async ({
    page,
  }) => {
    await page.goto("/admin/providers?tab=incidents");

    await page
      .getByPlaceholder("Provider outage, quota issue, degraded model")
      .fill("E2E incident opened from the console");
    await page
      .getByPlaceholder("User-facing note shown in the model selector.")
      .fill("Answers may be slower than usual while we route around this.");
    await page.getByRole("button", { name: "Enable incident mode" }).click();

    const created = page
      .locator("article")
      .filter({ hasText: "E2E incident opened from the console" });
    await expect(created).toBeVisible();

    const stored = await adminFixtureDatabase().adminProviderIncident.findFirst({
      where: { title: "E2E incident opened from the console" },
      select: { status: true, createdByEmail: true, resolvedAt: true },
    });
    expect(stored?.status).toBe("limited");
    expect(stored?.createdByEmail).toBe(ADMIN_E2E_IDENTITIES.ops.email);
    expect(stored?.resolvedAt).toBeNull();

    // Resolving the pre-seeded incident takes it out of the actionable set.
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(2);
    await page
      .locator("article")
      .filter({ hasText: FIXTURE_INCIDENT.active.title })
      .getByRole("button", { name: "Resolve" })
      .click();
    await expect(page.getByRole("button", { name: "Resolve" })).toHaveCount(1);

    const resolved = await adminFixtureDatabase().adminProviderIncident.findUniqueOrThrow({
      where: { id: FIXTURE_INCIDENT.active.id },
      select: { status: true, resolvedByEmail: true },
    });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedByEmail).toBe(ADMIN_E2E_IDENTITIES.ops.email);
  });

  test("a model registry status change is persisted and re-rendered", async ({
    page,
  }) => {
    await page.goto("/admin/models");
    await page
      .getByRole("button", { name: `Edit ${FIXTURE_MODEL.enabled.name}` })
      .click();

    const dialog = page.getByRole("dialog", {
      name: `Edit ${FIXTURE_MODEL.enabled.name}`,
    });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Runtime status").selectOption("limited");
    await dialog.getByRole("button", { name: "Save model" }).click();
    await expect(dialog).toBeHidden();

    const stored = await adminFixtureDatabase().modelRegistryEntry.findUniqueOrThrow({
      where: { id: FIXTURE_MODEL.enabled.id },
      select: { status: true, updatedByEmail: true },
    });
    expect(stored.status).toBe("limited");
    expect(stored.updatedByEmail).toBe(ADMIN_E2E_IDENTITIES.ops.email);

    await page.reload();
    await expect(
      page
        .locator("article")
        .filter({ hasText: FIXTURE_MODEL.enabled.name })
        .getByText("limited")
        .first()
    ).toBeVisible();
  });

  test("restricting the guest default model is refused with the cross-surface reason", async ({
    page,
  }) => {
    await page.goto("/admin/models");
    await page
      .getByPlaceholder("Search name, model ID, API ID, provider, or purpose")
      .fill(FIXTURE_APP_SETTINGS.guestDefaultModelId);

    const row = page
      .locator("article")
      .filter({ hasText: FIXTURE_APP_SETTINGS.guestDefaultModelId });
    await expect(row).toHaveCount(1);
    await row.getByRole("button", { name: /^Edit / }).click();

    const dialog = page.getByRole("dialog", { name: /^Edit / });
    await dialog.getByLabel("Runtime status").selectOption("limited");
    await dialog.getByRole("button", { name: "Save model" }).click();

    // The registry route refuses to restrict whatever Platform Settings points
    // the guest experience at, and names the surface to change first.
    await expect(
      page.getByText(
        "Change the Guest default model in Platform Settings before disabling or restricting this model."
      )
    ).toBeVisible();
    // The dialog stays open on a rejected save, and nothing is written.
    await expect(dialog).toBeVisible();
    expect(
      (
        await adminFixtureDatabase().modelRegistryEntry.findUniqueOrThrow({
          where: { id: FIXTURE_APP_SETTINGS.guestDefaultModelId },
          select: { status: true },
        })
      ).status
    ).toBe("enabled");
  });

  test("a platform setting is saved and read back", async ({ page }) => {
    await page.goto("/admin/platform");

    const guestModel = page.getByLabel("Leading engine");
    await expect(guestModel).toHaveValue(
      FIXTURE_APP_SETTINGS.guestDefaultModelId
    );
    await guestModel.selectOption(
      FIXTURE_APP_SETTINGS.alternateGuestDefaultModelId
    );
    await page.getByRole("button", { name: "Save platform settings" }).click();

    await expect(
      page.getByText("Platform settings saved and are live.")
    ).toBeVisible();
    const stored = await adminFixtureDatabase().appSetting.findUniqueOrThrow({
      where: { key: "guestDefaultModelId" },
    });
    expect(stored.value).toBe(
      FIXTURE_APP_SETTINGS.alternateGuestDefaultModelId
    );

    await page.reload();
    await expect(page.getByLabel("Leading engine")).toHaveValue(
      FIXTURE_APP_SETTINGS.alternateGuestDefaultModelId
    );
  });

  test("a failed alert delivery can be acknowledged", async ({ page }) => {
    await page.goto("/admin/alerts?tab=deliveries");
    const log = page
      .locator("section")
      .filter({ hasText: "Notification delivery log" });

    await expect(log.getByText(FIXTURE_NOTIFICATION.failed.title)).toBeVisible();
    await log.getByRole("button", { name: "Acknowledge" }).click();

    await expect(log.getByRole("button", { name: "Acknowledge" })).toHaveCount(0);
    const stored = await adminFixtureDatabase().adminNotificationLog.findUniqueOrThrow({
      where: { id: FIXTURE_NOTIFICATION.failed.id },
      select: { acknowledgedAt: true, acknowledgedByEmail: true },
    });
    expect(stored.acknowledgedAt).not.toBeNull();
    expect(stored.acknowledgedByEmail).toBe(ADMIN_E2E_IDENTITIES.ops.email);
  });

  test("webhook replay is a billing permission and reports its own failure", async ({
    page,
    signInAs,
  }) => {
    // Replay is billing:write, not ops:write, so the ops role is refused.
    const refusedForOps = await adminApi(page).post(
      `/api/admin/webhooks/${FIXTURE_WEBHOOK.failed.id}/reprocess`
    );
    expect(refusedForOps.status()).toBe(403);

    await signInAs("billing");
    await page.goto("/admin/automation?tab=webhooks");
    const monitor = page
      .locator("section")
      .filter({ hasText: "Billing event monitor" });
    await expect(
      monitor.getByText(FIXTURE_WEBHOOK.failed.stripeEventId)
    ).toBeVisible();

    await monitor.getByRole("button", { name: "Reprocess" }).click();

    // A successful replay re-fetches the event from Stripe, which this harness
    // deliberately cannot reach: no STRIPE_SECRET_KEY, and the network guard
    // blocks the call outright. What is assertable -- and what actually
    // regressed in the past -- is that the console surfaces the failure instead
    // of silently reporting success, and that the record is not marked
    // replayed. The success path is listed as an explicit exclusion in
    // docs/qa/e2e-coverage-matrix.md; it needs a Stripe fixture boundary that
    // does not exist yet.
    await expect(page.getByText("Stripe webhook was reprocessed.")).toHaveCount(0);
    await expect(monitor.getByText("failed").first()).toBeVisible();

    const stored = await adminFixtureDatabase().stripeWebhookEventLog.findUniqueOrThrow(
      {
        where: { id: FIXTURE_WEBHOOK.failed.id },
        select: { replayedAt: true, status: true },
      }
    );
    expect(stored.replayedAt).toBeNull();
    expect(stored.status).toBe("failed");
  });

  test("destructive retention cleanup stays locked until the confirmation phrase matches", async ({
    page,
  }) => {
    await page.goto("/admin/retention");
    const execute = page.getByRole("button", { name: "Execute cleanup" });

    await expect(execute).toBeDisabled();
    await page.getByPlaceholder("RUN CLEANUP").fill("run cleanup");
    await expect(execute).toBeDisabled();
    await page.getByPlaceholder("RUN CLEANUP").fill("RUN CLEANUP");
    await expect(execute).toBeEnabled();

    // A dry run is the non-destructive half and is always available.
    await page.getByRole("button", { name: "Dry run" }).click();
    await expect
      .poll(async () =>
        adminFixtureDatabase().adminRetentionRun.count({
          where: { mode: "dry-run", createdByEmail: ADMIN_E2E_IDENTITIES.ops.email },
        })
      )
      .toBeGreaterThan(0);
  });
});
