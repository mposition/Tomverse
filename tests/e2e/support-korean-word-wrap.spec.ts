import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`Korean support keeps words whole at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.goto("/support?lang=ko");
    const heading = page.getByRole("heading", { level: 1 });
    expect(await renderedWordLineCount(heading, "도와드릴까요?")).toBe(1);
    const intro = heading.locator("..").locator("p").nth(1);
    expect(await renderedWordLineCount(intro, "아래")).toBe(1);
    const feedback = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "제품 피드백", exact: true }) }).locator("p");
    expect(await renderedWordLineCount(feedback, "번역")).toBe(1);
    if (width === 320) {
      await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
      await feedback.evaluate(node => { node.textContent += ` https://example.com/${"long".repeat(30)}`; });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
