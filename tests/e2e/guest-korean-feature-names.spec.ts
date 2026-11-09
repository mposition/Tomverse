import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { GUEST_DAILY_CREDIT_LIMIT, mockGuestUsage } from "./support/chat-state-fixtures";

test.use({ hasTouch: true });

for (const width of [320, 1440]) for (const appearance of ["classic", "studio"] as const) {
  test(`Korean guest feature names stay consistent at ${width}px in ${appearance}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 1000 });
    await prepareGuestPage(page, "ko", appearance, appearance);
    await mockGuestUsage(page, 0, GUEST_DAILY_CREDIT_LIMIT);
    await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
    await page.route("**/api/products/chat/capabilities", (route) => route.fulfill({ json: { autoSelection: { offered: true } } }));
    let sends = 0;
    await page.route("**/api/chat", (route) => { sends++; return route.fulfill({ status: 503, json: { error: "No execution in naming test" } }); });
    await page.goto("/chat?lang=ko");
    const composer = page.locator('[data-testid="chat-input"]:visible');
    const switcher = composer.getByTestId("chat-product-switcher");
    await expect(switcher).toContainText("채팅");
    await expect(switcher).toContainText("모델 비교");
    await composer.getByTestId("composer-tools-button").click();
    const research = page.getByTestId("tools-deep-research-row");
    await expect(research).toContainText("심층 조사");
    await expect(research).not.toContainText("Deep Research");
    await page.keyboard.press("Escape");
    await switcher.getByTestId("chat-product-review").click();
    await expect(page).toHaveURL(/\/review\?lang=ko/);
    await expect(page.getByText("모델 비교", { exact: true }).filter({ visible: true }).first()).toBeVisible();
    expect(sends).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
