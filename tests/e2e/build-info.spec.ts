import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  expectNoHorizontalOverflow,
  mockAuthenticatedApi,
  prepareGuestPage,
} from "./support/app-fixtures";

// The sidebar (and its help menu) lives behind a drawer on mobile projects,
// but is always visible on desktop -- open it first wherever a test needs
// to reach sidebar-help-button.
const openSidebarIfNeeded = async (page: Page, testInfo: TestInfo) => {
  if (testInfo.project.name.startsWith("mobile")) {
    await page.getByTestId("mobile-sidebar-open").click();
  }
};

const clickSidebarHelpButton = (page: Page) => page.getByTestId("sidebar-help-button").click();

// STG-F010: a public, unauthenticated build-info endpoint plus a sidebar UI
// so QA/users can confirm which commit/deployment staging is actually
// running. UI scenarios mock the endpoint response (page.route) so every
// environment/field-missing case is exercised deterministically; the API
// contract tests hit the real, unmocked route to prove the actual wiring
// (method handling, cache header, auth-independence) works end to end.

const VALID_BUILD_INFO = {
  environment: "staging",
  commitSha: "c12e84489559ed1320293e1cf8099dd17a7e80a6",
  shortCommitSha: "c12e844",
  builtAt: "2026-07-25T04:21:10.000Z",
  deployedAt: null,
  deploymentId: "staging-20260725-042436",
};

const mockBuildInfo = (page: Page, body: unknown) =>
  page.route("**/api/build-info", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Cache-Control": "no-store" },
      body: JSON.stringify(body),
    })
  );

test.describe("build-info API contract (real endpoint)", () => {
  test("GET returns the public shape with a no-store cache header", async ({
    page,
  }) => {
    const response = await page.request.get("/api/build-info");
    expect(response.ok()).toBe(true);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["content-type"]).toContain("application/json");

    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "builtAt",
      "commitSha",
      "deployedAt",
      "deploymentId",
      "environment",
      "shortCommitSha",
    ]);
    expect(["development", "staging", "production", "test"]).toContain(
      body.environment
    );
    expect(body.deployedAt).toBeNull();
  });

  test("rejects non-GET methods", async ({ page }) => {
    // The app's global cross-origin mutation guard (lib/requestOrigin.ts)
    // rejects any non-GET request lacking a matching Origin/Sec-Fetch-Site
    // with 403 before the request ever reaches this route's handler (which
    // only exports GET, so Next.js itself would otherwise 405) -- either
    // way, the request must never succeed.
    const response = await page.request.post("/api/build-info");
    expect(response.ok()).toBe(false);
    expect([403, 405]).toContain(response.status());
  });

  test("returns the same response whether the caller is authenticated or not", async ({
    page,
  }) => {
    const guestResponse = await page.request.get("/api/build-info");
    const guestBody = await guestResponse.json();

    await mockAuthenticatedApi(page);
    const authedResponse = await page.request.get("/api/build-info");
    const authedBody = await authedResponse.json();

    expect(authedBody).toEqual(guestBody);
  });

  test("never leaks raw environment variables or secrets", async ({ page }) => {
    const response = await page.request.get("/api/build-info");
    const text = await response.text();
    for (const forbidden of [
      "DATABASE_URL",
      "SECRET",
      "API_KEY",
      "TOKEN",
      "postgres://",
      "postgresql://",
    ]) {
      expect(text.toUpperCase()).not.toContain(forbidden);
    }
  });
});

test.describe("build-info UI", () => {
  test("staging shows a visible STAGING badge pre-login", async ({ page }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, VALID_BUILD_INFO);
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await expect(page.getByTestId("build-staging-badge")).toBeVisible();
    await expect(page.getByTestId("build-staging-badge")).toHaveText("Staging");
  });

  test("production shows no staging badge", async ({ page }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, { ...VALID_BUILD_INFO, environment: "production" });
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await expect(page.getByTestId("build-staging-badge")).toHaveCount(0);
  });

  test("help menu build-info row opens the detail panel with full field values", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "The sidebar help menu is reached the same way, but exercised once on desktop to keep this test focused."
    );
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, VALID_BUILD_INFO);
    await page.goto("/chat");

    await clickSidebarHelpButton(page);
    await expect(page.getByTestId("build-info-panel")).toHaveCount(0);
    await page.getByTestId("sidebar-build-info-toggle").click();

    const panel = page.getByTestId("build-info-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Staging");
    await expect(panel).toContainText("c12e844");
    await expect(panel).toContainText("2026-07-25T04:21:10.000Z");
    await expect(panel).toContainText("staging-20260725-042436");
    // The full SHA and the null deployedAt are reachable/honest, not hidden.
    await expect(panel.locator('[title="c12e84489559ed1320293e1cf8099dd17a7e80a6"]')).toHaveCount(1);
    await expect(panel).toContainText("Not available");
  });

  test("missing fields render 'Not available' rather than disappearing", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, {
      environment: "development",
      commitSha: null,
      shortCommitSha: null,
      builtAt: null,
      deployedAt: null,
      deploymentId: null,
    });
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").click();
    const panel = page.getByTestId("build-info-panel");
    await expect(panel).toBeVisible();
    const notAvailableCount = await panel.getByText("Not available").count();
    expect(notAvailableCount).toBeGreaterThanOrEqual(4);
  });

  test("copy build info writes the expected text and shows a success toast", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, VALID_BUILD_INFO);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").click();
    await page.getByTestId("build-info-copy-button").click();

    await expect(page.getByRole("status")).toContainText("copied", { ignoreCase: true });
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toContain("Environment: staging");
    expect(clipboardText).toContain(
      "Commit: c12e84489559ed1320293e1cf8099dd17a7e80a6"
    );
    expect(clipboardText).toContain("Built: 2026-07-25T04:21:10.000Z");
    expect(clipboardText).toContain("Deployment: staging-20260725-042436");
  });

  test("build-info toggle has a real hit area and the panel does not overflow at 320px", async ({
    page,
  }, testInfo) => {
    test.skip(
      !testInfo.project.name.startsWith("mobile"),
      "This checks the mobile drawer's own layout (mobile-sidebar-open), which only renders in the mobile shell."
    );
    await page.setViewportSize({ width: 320, height: 640 });
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, VALID_BUILD_INFO);
    await page.goto("/chat");

    await page.getByTestId("mobile-sidebar-open").click();
    await clickSidebarHelpButton(page);
    const toggle = page.getByTestId("sidebar-build-info-toggle");
    await toggle.click();
    await expect(page.getByTestId("build-info-panel")).toBeVisible();

    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(43.5);

    await expectNoHorizontalOverflow(page);
  });

  test("the build-info toggle is keyboard operable", async ({ page }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, VALID_BUILD_INFO);
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("build-info-panel")).toBeVisible();
  });
});
