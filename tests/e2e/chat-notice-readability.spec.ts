import { expect, test } from "@playwright/test";
import { mockAuthenticatedApi, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) for (const appearance of ["classic", "studio"] as const) {
  test(`Chat notices stay readable at ${width}px in ${theme} ${appearance}`, async ({ page, baseURL }, info) => {
    test.skip(info.project.name !== "desktop-chromium", "Explicit phone and desktop viewports.");
    await page.setViewportSize({ width, height: width < 768 ? 720 : 1000 });
    await prepareGuestPage(page, "ko", appearance, appearance);
    const account = await mockAuthenticatedApi(page, { productKey: "chat", language: "ko", selectedModels: ["gpt-6-luna"], selectionMode: "auto", autoSelectionOffered: true });
    account.theme = theme;
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([
      { name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! },
      { name: "__tomverse_e2e_analytics", value: "1", url: baseURL! },
    ]);
    await page.setExtraHTTPHeaders({ "cf-ipcountry": "DE" });
    await page.route("**/api/products/chat/capabilities", route => route.fulfill({ json: { autoSelection: { offered: true } } }));
    await page.route("**/api/analytics/events", route => route.fulfill({ status: 202, body: "" }));
    await page.goto("/chat?lang=ko");
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
    const warning = page.getByTestId(width < 768 ? "chat-ai-disclaimer-mobile" : "chat-ai-disclaimer");
    const consent = page.getByTestId("chat-consent-notice");
    await expect(consent).toBeVisible({ timeout: 15_000 });
    for (const element of [warning, consent.locator("p:visible").first()]) {
      await element.scrollIntoViewIfNeeded();
      await expect(element).toBeVisible();
      const typography = await element.evaluate(node => ({ size: Number.parseFloat(getComputedStyle(node).fontSize), leading: Number.parseFloat(getComputedStyle(node).lineHeight) }));
      expect(typography.size).toBeGreaterThanOrEqual(14);
      expect(typography.leading).toBeGreaterThanOrEqual(20);
      expect((await expectAccessibleContrast(element, "Readable Chat notice")).ratio).toBeGreaterThanOrEqual(4.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await consent.scrollIntoViewIfNeeded();
    await consent.getByTestId("analytics-consent-decline").click();
    await expect(consent).toBeHidden();
    if (width < 768) {
      await warning.getByRole("button").click();
      const details = page.getByTestId("chat-ai-disclaimer-sheet");
      await expect(details).toBeVisible();
      await expect(details).toContainText("선택한 AI 공급자에 전송될 수 있으니");
      expect(await details.locator("p").last().evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
      await page.keyboard.press("Escape");
      await expect(details).toBeHidden();
    }
    await expect(page.getByTestId("chat-textarea")).toHaveValue("");
  });
}
