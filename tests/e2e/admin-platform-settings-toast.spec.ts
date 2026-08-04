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

test.describe("platform settings save refusals", () => {
  test("a step-up prompt tells the operator to sign in, not to retry", async ({
    page,
  }) => {
    await page.route("**/api/admin/app-settings", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill(
            json(
              {
                error:
                  "Sign in again before performing this high-risk administrator action.",
                code: "ADMIN_REAUTHENTICATION_REQUIRED",
              },
              428
            )
          )
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
        ? route.fulfill(
            json({
              settings: {
                guestDefaultModelId: "gpt-5-6-luna",
                aiChatEnabled: true,
                attachmentsEnabled: true,
                publicSharingEnabled: true,
              },
              imageGenerationEnabled: false,
              externalConversationImportEnabled: true,
            })
          )
        : route.continue()
    );

    await openFixture(page);
    await page.getByTestId("admin-external-import-flag").click();
    await save(page);

    await expect(page.getByText(/saved and are live/i)).toBeVisible();
  });
});
