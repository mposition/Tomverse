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
  deploymentId: "staging-20260725-042436",
  deploymentStartedAt: "2026-07-25T04:22:00.000Z",
  deployedAt: "2026-07-25T04:24:36.000Z",
  deploymentStatus: "success",
};

// Fixture for a deployment Railway has only reported a start time for (Path
// B) -- deployedAt must stay null and the UI must label the one timestamp it
// does have as "Deployment started", never fudge it into "Deployment
// completed".
const STARTED_ONLY_BUILD_INFO = {
  ...VALID_BUILD_INFO,
  deployedAt: null,
  deploymentStatus: "in_progress",
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
  test("GET returns the public shape with a no-store cache header", { tag: "@smoke" }, async ({
    page,
  }) => {
    const response = await page.request.get("/api/build-info");
    expect(response.ok()).toBe(true);
    // `private` as well as `no-store`, and both are asserted rather than a
    // `toContain("no-store")` that would pass if the proxy stopped saying
    // `private`. The route file still writes `no-store`; the proxy adds
    // `private` across `/api/*`, and build-info is not one of the five routes
    // that choose their own caching, so this is what a client actually sees.
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["content-type"]).toContain("application/json");

    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual([
      "builtAt",
      "commitSha",
      "deployedAt",
      "deploymentId",
      "deploymentStartedAt",
      "deploymentStatus",
      "environment",
      "shortCommitSha",
    ]);
    expect(["development", "staging", "production", "test"]).toContain(
      body.environment
    );
    // This suite runs without RAILWAY_API_TOKEN/RAILWAY_DEPLOYMENT_ID
    // configured, so the real (unmocked) endpoint must resolve deployment
    // timestamps to null rather than fabricating them -- see the UI-scenario
    // tests below for the mocked, fixture-driven cases.
    expect(body.deployedAt).toBeNull();
    expect(body.deploymentStartedAt).toBeNull();
    expect(body.deploymentStatus).toBe("unknown");
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
    // The full SHA is reachable via tooltip/detail, not hidden.
    await expect(panel.locator('[title="c12e84489559ed1320293e1cf8099dd17a7e80a6"]')).toHaveCount(1);
    // Deployment-started and deployment-completed are distinct rows with
    // distinct real values -- never the same label doing double duty.
    await expect(panel).toContainText("Deployment started");
    await expect(panel).toContainText("2026-07-25T04:22:00.000Z");
    await expect(panel).toContainText("Deployment completed");
    await expect(panel).toContainText("2026-07-25T04:24:36.000Z");
  });

  test("a completed-timestamp fixture shows 'Deployment completed' with the real value", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, VALID_BUILD_INFO);
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").click();
    const panel = page.getByTestId("build-info-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Deployment completed");
    await expect(panel).toContainText("2026-07-25T04:24:36.000Z");
    // The build timestamp and the deployment-completed timestamp are
    // different real values in this fixture -- confirms the two are never
    // confused/copied onto each other.
    await expect(panel).toContainText("2026-07-25T04:21:10.000Z");
  });

  test("a started-only fixture shows 'Deployment started' and leaves 'Deployment completed' honestly unavailable", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, STARTED_ONLY_BUILD_INFO);
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").click();
    const panel = page.getByTestId("build-info-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Deployment started");
    await expect(panel).toContainText("2026-07-25T04:22:00.000Z");
    const completedRow = panel.getByText("Deployment completed").locator("..");
    await expect(completedRow).toContainText("Not available");
  });

  test("missing fields render 'Not available' rather than disappearing, and never borrow the build timestamp", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await mockBuildInfo(page, {
      environment: "development",
      commitSha: null,
      shortCommitSha: null,
      builtAt: null,
      deploymentId: null,
      deploymentStartedAt: null,
      deployedAt: null,
      deploymentStatus: "unknown",
    });
    await page.goto("/chat");
    await openSidebarIfNeeded(page, testInfo);

    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").click();
    const panel = page.getByTestId("build-info-panel");
    await expect(panel).toBeVisible();
    const notAvailableCount = await panel.getByText("Not available").count();
    // Built, deployment-started, deployment-completed, and deployment ID all
    // honestly report unavailable rather than any of them borrowing another
    // field's value.
    expect(notAvailableCount).toBeGreaterThanOrEqual(4);
    const startedRow = panel.getByText("Deployment started").locator("..");
    await expect(startedRow).toContainText("Not available");
    const completedRow = panel.getByText("Deployment completed").locator("..");
    await expect(completedRow).toContainText("Not available");
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
    expect(clipboardText).toContain("Deployment started: 2026-07-25T04:22:00.000Z");
    expect(clipboardText).toContain("Deployment completed: 2026-07-25T04:24:36.000Z");
    expect(clipboardText).toContain("Deployment: staging-20260725-042436");
  });

  // STG-F010 (R-07). Every UI test above mocks the endpoint so the awkward
  // shapes (missing deployedAt, production vs staging) can be exercised
  // deterministically. None of them proves the unmocked wiring: that what the
  // panel renders is what this deployment's own /api/build-info actually says.
  // This one takes the live response and requires every non-null field to be
  // present in the panel, so a field that silently stops being wired through
  // -- or gets rendered from a different source -- fails here.
  test("the panel renders the live endpoint's own values, field for field", async ({
    page,
  }, testInfo) => {
    await prepareGuestPage(page, "en");
    await page.goto("/chat");

    const live = await page.evaluate(async () => {
      const response = await fetch("/api/build-info", { cache: "no-store" });
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: (await response.json()) as Record<string, unknown>,
      };
    });
    expect(live.status).toBe(200);
    expect(live.cacheControl).toContain("no-store");

    await openSidebarIfNeeded(page, testInfo);
    await clickSidebarHelpButton(page);
    await page.getByTestId("sidebar-build-info-toggle").click();
    const panel = page.getByTestId("build-info-panel");
    await expect(panel).toBeVisible();
    const panelText = (await panel.innerText()).replace(/\s+/g, " ");

    // The short SHA, the deployment id and every timestamp the endpoint
    // actually reports have to be readable in the panel.
    for (const field of [
      "shortCommitSha",
      "deploymentId",
      "builtAt",
      "deploymentStartedAt",
      "deployedAt",
    ] as const) {
      const value = live.body[field];
      if (typeof value !== "string" || value.length === 0) continue;
      expect(
        panelText,
        `${field} ("${value}") must be visible in the build-info panel`
      ).toContain(value);
    }

    // The full SHA stays reachable rather than being truncated away.
    if (typeof live.body.commitSha === "string" && live.body.commitSha) {
      await expect(
        panel.locator(`[title="${live.body.commitSha}"]`),
        "the full commit SHA must remain reachable"
      ).toHaveCount(1);
    }

    // And nothing beyond the documented shape leaks into the UI.
    expect(panelText).not.toMatch(/DATABASE_URL|NEXTAUTH_SECRET|sk-|postgres:\/\//i);
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
