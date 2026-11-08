import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { expectAccessibleContrast, expectInsideVisibleViewport } from "./support/ui-audit";
import { en } from "../../locales/en";

test.use({ hasTouch: true });
for (const appearance of ["classic", "studio"] as const) for (const theme of ["light", "dark"] as const) {
  test(`mobile ${appearance} warning and Details are readable in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 568 });
    await prepareGuestPage(page, "en", appearance, appearance);
    await setDeterministicTheme(page, theme);
    await page.goto("/chat?lang=en");
    const notice = page.getByTestId("chat-ai-disclaimer-mobile");
    const summary = notice.locator("span").first();
    const details = page.getByTestId("chat-ai-disclaimer-details");
    await expect(summary).toHaveText(en.chat.aiDisclaimerShort, { timeout: 30_000 });
    for (const element of [summary, details]) {
      expect(await element.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(12);
      await expectAccessibleContrast(element, `${theme} warning text`);
    }
    const box = (await details.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await details.tap();
    await expect(page.getByTestId("chat-ai-disclaimer-sheet")).toContainText(en.chat.aiDisclaimer);
    await page.keyboard.press("Escape");
    await expect(details).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("chat-ai-disclaimer-sheet")).toBeVisible();
    await page.keyboard.press("Escape");
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expectNoHorizontalOverflow(page);
    const input = page.getByTestId("chat-textarea");
    await input.scrollIntoViewIfNeeded();
    await expectInsideVisibleViewport(page, input, "Enlarged-text composer");
    const inputBox = (await input.boundingBox())!;
    expect(inputBox.x).toBeGreaterThanOrEqual(-1);
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(321);
    expect(inputBox.height).toBeGreaterThanOrEqual(44);
  });
}
