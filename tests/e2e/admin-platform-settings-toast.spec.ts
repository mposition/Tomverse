import { expect, test, type Page } from "@playwright/test";

/**
 * What the platform settings panel says when a save is refused.
 *
 * The endpoint refuses for four reasons an operator can act on, and the
 * actions differ: sign in again (428 step-up), pick a different guest default
 * (400), wait (429), get the permission (403). The panel used to put the
 * server's explanation into an Error and then swallow it with a bare
 * `catch {}`, so all four rendered as one sentence ending in "retry" -- advice
 * that can never succeed for a 428, which is exactly the loop this guards.
 *
 * Responses are controlled with network interception; the real handler keeps
 * its session, permission, rate-limit and reauthentication checks.
 */

const FIXTURE = "/e2e/admin-console-fixture?view=settings";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function openFixture(page: Page) {
  await page.goto(FIXTURE);
  await expect(
    page.getByTestId("admin-external-import-flag")
  ).toBeVisible();
  // The panel is a client component with local state; wait for hydration so
  // the click below reaches a live handler rather than static markup.
  await page.waitForFunction(() => {
    const element = document.querySelector(
      '[data-testid="admin-external-import-flag"]'
    );
    return (
      !!element &&
      Object.keys(element).some((key) => key.startsWith("__reactFiber$"))
    );
  });
}

const save = (page: Page) =>
  page.getByRole("button", { name: /Save platform settings/i }).click();

const SETTINGS_BODY = {
  settings: {
    guestDefaultModelId: "gpt-5-6-luna",
    aiChatEnabled: true,
    attachmentsEnabled: true,
    publicSharingEnabled: true,
  },
  imageGenerationEnabled: false,
  externalConversationImportEnabled: true,
  assistantProfilesEnabled: false,
  assistantKnowledgeEnabled: false,
};

const REAUTHENTICATION_BODY = {
  error: "Sign in again before performing this high-risk administrator action.",
  code: "ADMIN_REAUTHENTICATION_REQUIRED",
};

test.describe("platform settings save refusals", () => {
  test("a step-up prompt tells the operator to sign in, not to retry", async ({
    page,
  }) => {
    await page.route("**/api/admin/app-settings", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill(json(REAUTHENTICATION_BODY, 428))
        : route.continue()
    );

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);

    const toast = page.getByText(/were not saved/i);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/sign in again/i);
    // The advice that cannot work for a 428 must not be what it says.
    await expect(toast).not.toContainText(/retry, or reload/i);
    // And nothing anywhere may report the refused save as done.
    await expect(page.getByText(/saved and are live/i)).toHaveCount(0);
  });

  test("a step-up prompt leaves a recovery on screen, not just a toast", async ({
    page,
  }) => {
    await page.route("**/api/admin/app-settings", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill(json(REAUTHENTICATION_BODY, 428))
        : route.continue()
    );

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);

    // The alert is the recovery; a toast that fades would leave the operator
    // with Save as the only visible action and no way past the 428.
    const alert = page.getByTestId("admin-platform-reauthentication");
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(/Nothing was saved/i);
    await expect(alert).toContainText(/not be re-sent/i);

    const cta = page.getByTestId("admin-platform-reauthenticate-link");
    await expect(cta).toBeVisible();
    await expect(cta).toHaveText(/Sign in again to continue/i);
    // The step-up URL, carrying this screen as the callback -- so the operator
    // comes back here to review and submit the change again.
    await expect(cta).toHaveAttribute(
      "href",
      "/auth/admin-reauthenticate?callbackUrl=%2Fadmin%2Fplatform&mode=recent"
    );
  });

  test("a step-up prompt does not re-send the refused change", async ({
    page,
  }) => {
    const patches: string[] = [];
    await page.route("**/api/admin/app-settings", (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches.push(route.request().postData() || "");
      return route.fulfill(json(REAUTHENTICATION_BODY, 428));
    });

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);
    await expect(
      page.getByTestId("admin-platform-reauthentication")
    ).toBeVisible();

    // Save is the primary control on this panel, so while a step-up is
    // outstanding it has to stop being the thing that gets pressed: every
    // press would produce the same 428, and an automatic retry would be a
    // high-risk write nobody re-approved.
    const saveButton = page.getByTestId("admin-platform-save");
    await expect(saveButton).toBeDisabled();
    await page.waitForTimeout(1_000);
    expect(patches).toHaveLength(1);
  });

  test("after signing in again the same edit saves from a fresh load", async ({
    page,
  }) => {
    // What the operator meets on the way back from the reauthentication flow:
    // a full navigation, the panel loaded from stored settings, the edit made
    // again by hand, and this time the endpoint accepts it.
    let stepUpExpired = true;
    const patches: string[] = [];
    await page.route("**/api/admin/app-settings", (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      patches.push(route.request().postData() || "");
      return stepUpExpired
        ? route.fulfill(json(REAUTHENTICATION_BODY, 428))
        : route.fulfill(json(SETTINGS_BODY));
    });

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);
    await expect(
      page.getByTestId("admin-platform-reauthentication")
    ).toBeVisible();

    stepUpExpired = false;
    await openFixture(page);
    // A fresh load carries no alert and no memory of the refused attempt.
    await expect(
      page.getByTestId("admin-platform-reauthentication")
    ).toHaveCount(0);
    await expect(page.getByTestId("admin-platform-save")).toBeEnabled();

    await page.getByTestId("admin-external-import-flag").click();
    await save(page);
    await expect(page.getByText(/saved and are live/i)).toBeVisible();
    expect(patches).toHaveLength(2);
  });

  test("any other refusal shows the reason the server gave", async ({
    page,
  }) => {
    await page.route("**/api/admin/app-settings", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill(
            json(
              {
                error:
                  "Guest default model must be an enabled guest-accessible Standard model.",
              },
              400
            )
          )
        : route.continue()
    );

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);

    const toast = page.getByText(/were not saved/i);
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(
      /Guest default model must be an enabled guest-accessible Standard model/i
    );
    // Still says nothing changed: the endpoint is all-or-nothing.
    await expect(toast).toContainText(/Nothing changed/i);
  });

  test("a successful save says so", async ({ page }) => {
    await page.route("**/api/admin/app-settings", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill(json(SETTINGS_BODY))
        : route.continue()
    );

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);

    await expect(page.getByText(/saved and are live/i)).toBeVisible();
  });
});
