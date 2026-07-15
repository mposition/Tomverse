import { expect, test, type Page } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

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
