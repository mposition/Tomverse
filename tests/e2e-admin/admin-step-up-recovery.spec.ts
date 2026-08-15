import {
  ADMIN_E2E_BASE_URL,
  FIXTURE_APP_SETTINGS,
  expect,
  test,
} from "./support/console";
import { adminFixtureDatabase } from "./support/database";
import { SESSION_COOKIE_NAME } from "./support/session";

/**
 * The whole way out of a 428 on `/admin/platform`, end to end.
 *
 * This is the journey that had no exit. A session inside the 8-hour console
 * window but past the 30-minute step-up window renders the console perfectly
 * and is refused every high-risk write. The panel raised a toast that faded,
 * the only visible control was the Save that had just failed, and the
 * reauthentication link went to a page which -- seeing an *authorized* session
 * -- redirected straight back to the screen it came from.
 *
 * So each step is asserted rather than the endpoint alone: the refusal leaves
 * a recovery on screen, the recovery leads to a card and not a redirect loop,
 * the card really ends the session, and a fresh sign-in gets the change saved
 * and stored. Nothing here relaxes the step-up rule; the 428 is expected and
 * the change only lands after a genuinely recent sign-in.
 */

test.describe("high-risk step-up recovery", () => {
  test("a refused platform save recovers through reauthentication", async ({
    page,
    context,
    signInAs,
  }) => {
    // 1. Past the step-up window, inside the console window.
    await signInAs("ops", { authenticatedMinutesAgo: 45 });

    // 2. Change a platform flag and save.
    await page.goto("/admin/platform");
    const imageFlag = page.getByTestId("admin-image-generation-flag");
    await expect(imageFlag).not.toBeChecked();
    await imageFlag.check();
    await page.getByRole("button", { name: "Save platform settings" }).click();

    // 3. The refusal is recoverable on screen, and nothing was written.
    const alert = page.getByTestId("admin-platform-reauthentication");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Nothing was saved/i);
    await expect(page.getByTestId("admin-platform-save")).toBeDisabled();
    expect(
      (
        await adminFixtureDatabase().appSetting.findUnique({
          where: { key: "feature.imageGenerationEnabled" },
        })
      )?.value ?? null
    ).not.toBe("true");

    // 4. The CTA leads to the card -- not back to the screen that refused.
    await page.getByTestId("admin-platform-reauthenticate-link").click();
    await expect(page).toHaveURL(
      "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Fplatform&mode=recent"
    );
    const card = page.getByTestId("admin-reauthentication-card");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-reason", "recent-auth");
    await expect(card).toContainText(/Admin Console session is still valid/i);
    await expect(card).toContainText(/refresh cannot renew/i);

    // A reload is not a way through it: the same card comes back, which is the
    // property the copy promises.
    await page.reload();
    await expect(
      page.getByTestId("admin-reauthentication-card")
    ).toHaveAttribute("data-reason", "recent-auth");

    // 5. Signing out really ends the session and asks for a fresh sign-in.
    await page.getByTestId("admin-reauthentication-submit").click();
    await page.waitForURL(/\/auth\/signin/, { waitUntil: "commit" });
    expect(page.url()).toContain("callbackUrl=%2Fadmin%2Fplatform");
    expect(page.url()).toContain("reason=admin-step-up-expired");
    const cookies = await context.cookies(ADMIN_E2E_BASE_URL);
    expect(cookies.some((entry) => entry.name === SESSION_COOKIE_NAME)).toBe(
      false
    );

    // 6. The sign-in itself is what mints a new `authenticatedAt`; the harness
    // stands in for the identity provider round trip and nothing else.
    await signInAs("ops");

    // 7. Back on the same screen, the edit is made again by hand and saved.
    await page.goto("/admin/platform");
    await expect(
      page.getByTestId("admin-platform-reauthentication")
    ).toHaveCount(0);
    const flagAfterSignIn = page.getByTestId("admin-image-generation-flag");
    // The refused save left nothing behind, so the box is clear again -- the
    // change was never queued for replay.
    await expect(flagAfterSignIn).not.toBeChecked();
    await flagAfterSignIn.check();
    await page.getByRole("button", { name: "Save platform settings" }).click();

    await expect(
      page.getByText("Platform settings saved and are live.")
    ).toBeVisible();
    const stored = await adminFixtureDatabase().appSetting.findUniqueOrThrow({
      where: { key: "feature.imageGenerationEnabled" },
    });
    expect(stored.value).toBe("true");

    await page.reload();
    await expect(
      page.getByTestId("admin-image-generation-flag")
    ).toBeChecked();
  });

  test("a stale step-up window still reaches the console and its reads", async ({
    page,
    signInAs,
  }) => {
    // The other half of the contract: the step-up window is not console
    // access. Widening the recovery must not have turned a 428 into a lockout.
    await signInAs("ops", { authenticatedMinutesAgo: 45 });
    await page.goto("/admin/platform");
    await expect(page.getByLabel("Leading engine")).toHaveValue(
      FIXTURE_APP_SETTINGS.guestDefaultModelId
    );
    await expect(page.getByTestId("admin-platform-save")).toBeEnabled();
  });

  test("the reauthentication page is not an oracle for a non-administrator", async ({
    page,
    signInAs,
  }) => {
    await signInAs("member");
    const response = await page.goto(
      "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Fplatform&mode=recent"
    );
    expect(response?.status()).toBe(404);
  });

  test("a still-recent sign-in is sent straight back to the console", async ({
    page,
    signInAs,
  }) => {
    await signInAs("ops");
    await page.goto(
      "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Fplatform&mode=recent"
    );
    await expect(page).toHaveURL("/admin/platform");
  });

  test("the console offers a sign-out from every viewport", async ({
    page,
    signInAs,
  }) => {
    await signInAs("ops");
    await page.goto("/admin/overview");

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      const trigger = page.getByTestId("admin-account-menu-trigger");
      await expect(trigger).toBeVisible();
      await trigger.click();
      await expect(
        page.getByRole("menuitem", { name: "Sign out" })
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("admin-account-menu")).toHaveCount(0);
    }
  });
});
