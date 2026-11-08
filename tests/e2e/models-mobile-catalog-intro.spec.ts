import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`Korean mobile model cards start promptly with expandable guidance in ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_analytics", value: "1", url: baseURL! }]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.goto("/models?lang=ko");
    await expect(page.getByTestId("chat-consent-notice")).toBeVisible();
    const details = page.getByTestId("models-mobile-usage-details");
    await expect(details).not.toHaveAttribute("open");
    const firstCard = page.getByRole("article").first();
    await expect(firstCard).toBeVisible();
    expect(await firstCard.evaluate((node) => node.getBoundingClientRect().top + scrollY)).toBeLessThan(800);
    await details.locator("summary").focus();
    await details.locator("summary").press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(details.getByText(/1.5배, 2배 또는 3배/)).toBeVisible();
    await details.locator("summary").press("Enter");
    await expect(details).not.toHaveAttribute("open");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("desktop keeps the complete model usage guidance visible", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/models?lang=ko");
  await expect(page.getByTestId("models-mobile-usage-details")).toBeHidden();
  await expect(page.getByText(/긴 대화와 파일은 입력 크기에 따라 기본 크레딧의 1.5배/).filter({ visible: true })).toBeVisible();
});
