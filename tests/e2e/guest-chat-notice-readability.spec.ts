import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { GUEST_DAILY_CREDIT_LIMIT, mockGuestUsage, setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast } from "./support/ui-audit";

test.use({ hasTouch: true });

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) for (const appearance of ["classic", "studio"] as const) {
  test(`guest AI/privacy notice is readable at ${width}px in ${theme} ${appearance}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko", appearance, appearance);
    await mockGuestUsage(page, 0, GUEST_DAILY_CREDIT_LIMIT);
    await setDeterministicTheme(page, theme);
    await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
    await page.goto("/chat?lang=ko");
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
    const notice = page.getByTestId(width === 320 ? "chat-ai-disclaimer-mobile" : "chat-ai-disclaimer");
    await expect(notice).toBeVisible();
    const typography = await notice.evaluate((node) => ({ size: parseFloat(getComputedStyle(node).fontSize), leading: parseFloat(getComputedStyle(node).lineHeight) }));
    expect(typography.size).toBeGreaterThanOrEqual(14);
    expect(typography.leading).toBeGreaterThanOrEqual(20);
    await expectAccessibleContrast(notice, "Guest AI/privacy notice");
    if (width === 320) {
      await notice.getByRole("button").click();
      const sheet = page.getByTestId("chat-ai-disclaimer-sheet");
      await expect(sheet).toBeVisible();
      await expect(sheet).toContainText("선택한 AI 공급자에 전송될 수 있으니");
      expect(await sheet.locator("p").last().evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    }
    await expect(page.getByTestId("chat-textarea")).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
