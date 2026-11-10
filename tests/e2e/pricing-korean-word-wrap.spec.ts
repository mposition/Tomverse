import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`Korean pricing keeps words whole at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.goto("/pricing?lang=ko");
    const intro = page.getByRole("heading", { level: 1 }).locator("..").locator("p").nth(1);
    for (const word of ["자주", "있습니다."]) expect(await renderedWordLineCount(intro, word)).toBe(1);
    const free = page.getByTestId("pricing-plan-card-free");
    expect(await renderedWordLineCount(free.locator("li").filter({ hasText: "다운로드" }), "다운로드")).toBe(1);
    const pro = page.getByTestId("pricing-plan-card-pro");
    expect(await renderedWordLineCount(pro.getByTestId("pricing-annual-checkout-note"), "확인하세요.")).toBe(1);
    if (width === 320) {
      await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
      await intro.evaluate(node => { node.textContent += ` https://example.com/${"long".repeat(30)}`; });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
