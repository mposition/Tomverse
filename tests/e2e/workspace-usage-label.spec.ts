import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { mockUserUsage } from "./support/chat-state-fixtures";

for (const appearance of ["classic", "studio"] as const) {
  test(`Korean ${appearance} header identifies monthly usage and explains the period`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepareGuestPage(page, "ko", appearance);
    await mockAuthenticatedApi(page, { productKey: "chat", selectedModels: ["gpt-6-luna"], language: "ko" });
    await mockUserUsage(page, { plan: "Pro", usage: { creditsMonth: 180 }, limits: { creditsMonth: 3000 } });
    await page.goto("/chat?lang=ko");
    const button = page.getByTestId("workspace-usage");
    await expect(button).toContainText("현재 사용량 6%", { timeout: 30_000 });
    await expect(button.locator("span")).toBeVisible();
    await expect(button).toHaveAttribute("title", /UTC 기준.*180 \/ 월간 한도 3,000/);
    await button.focus();
    await expect(button).toHaveAccessibleDescription(/이번 달.*100%까지/);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("settings-tab-plan")).toBeVisible();
  });
}
