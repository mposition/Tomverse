import { expect, test, type Page } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";

const modelMenuTrigger = (page: Page) =>
  page.locator('button[aria-controls="chat-input-popover"]').nth(1);

type MockStatus = "limited" | "unavailable";

async function mockProviderStatus(page: Page, status: MockStatus) {
  let requestCount = 0;
  await page.route("**/api/models/status", async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gemini-2-5-flash",
            provider: "google",
            status,
            fallbackModelIds: ["claude-haiku-4-5"],
          },
        ],
      }),
    });
  });
  return () => requestCount;
}

test("limited provider health stays hidden from users", async ({ page }) => {
  await prepareGuestPage(page, "en");
  const requestCount = await mockProviderStatus(page, "limited");

  await page.goto("/chat");
  await expect.poll(requestCount).toBeGreaterThan(0);
  await page.waitForTimeout(150);

  await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
  const dismissOnboarding = page.getByRole("button", {
    name: "Start using Tomverse",
  });
  if (await dismissOnboarding.isVisible()) {
    await dismissOnboarding.click();
  }
  await page.locator('button[aria-controls="chat-input-popover"]').nth(1).click();
  await expect(page.locator('[title="limited"]')).toHaveCount(0);
});

test("outage remains visible with a fallback suggestion", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await mockProviderStatus(page, "unavailable");

  await page.goto("/chat");

  const banner = page.getByTestId("provider-outage-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("1 unavailable");
  await expect(banner).toContainText("Claude Haiku 4.5");
});

test("retired models stay out of the user model catalogue", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.route("**/api/models/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gemini-2-5-pro",
            provider: "google",
            status: "unavailable",
            fallbackModelIds: ["gemini-3-1-pro"],
          },
        ],
      }),
    });
  });

  await page.goto("/chat");
  await expect(page.getByTestId("provider-outage-banner")).toHaveCount(0);
  const dismissOnboarding = page.getByRole("button", {
    name: "Start using Tomverse",
  });
  if (await dismissOnboarding.isVisible()) {
    await dismissOnboarding.click();
  }

  await page.locator('button[aria-controls="chat-input-popover"]').nth(1).click();
  await expect(page.getByText("Gemini 2.5 Pro", { exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole("dialog", { name: "Choose AI models" })
      .getByTestId("model-option")
      .filter({ hasText: "Gemini 3.1 Pro" })
  ).toBeVisible();
});

test("clicking the banner's suggestion swaps the failed model instead of silently failing at the cap", async ({
  page,
}) => {
  // Regression test for a reported bug: with 3 models already selected (the
  // max), the banner's suggestion button used to call the plain add/toggle
  // handler, which rejects once at the cap -- so clicking it did nothing at
  // all, and the failed model stayed selected. It must swap instead.
  await mockAuthenticatedApi(page);
  await page.route("**/api/models/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        generatedAt: new Date().toISOString(),
        models: [
          {
            id: "gpt-5-4-mini",
            provider: "openai",
            status: "unavailable",
            fallbackModelIds: ["mistral-small-4"],
          },
        ],
      }),
    });
  });

  await page.goto("/chat?lang=en");
  await modelMenuTrigger(page).click();
  await page
    .locator('[data-testid="model-option"][data-model-id="gemini-2-5-flash"]')
    .click();
  await page
    .locator('[data-testid="model-option"][data-model-id="claude-haiku-4-5"]')
    .click();
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);

  const banner = page.getByTestId("provider-outage-banner");
  await expect(banner).toBeVisible();
  const swapButton = banner.getByRole("button", {
    name: "Switch GPT-5.4 mini for Mistral Small 4",
  });
  await expect(swapButton).toBeVisible();

  await swapButton.click();

  await expect(
    page.locator('[data-testid="desktop-model-panel"][data-model-id="gpt-5-4-mini"]')
  ).toHaveCount(0);
  await expect(
    page.locator('[data-testid="desktop-model-panel"][data-model-id="mistral-small-4"]')
  ).toBeVisible();
  // Still exactly 3 panels -- the failed model was replaced in place, not
  // just added on top (which the cap would have rejected outright).
  await expect(page.getByTestId("desktop-model-panel")).toHaveCount(3);
});
