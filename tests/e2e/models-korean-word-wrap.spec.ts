import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const width of [320, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`Korean model text keeps words whole at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.goto("/models?lang=ko");
    const title = page.getByRole("heading", { level: 1 });
    expect(await renderedWordLineCount(title, "찾아보세요.")).toBe(1);
    // Phones show the short introduction; the full one is hidden below sm (#3546).
    const intro = width === 320 ? page.getByTestId("models-mobile-usage-details").locator("..").locator("p").first() : title.locator("..").locator("p").nth(1);
    for (const word of width === 320 ? ["크레딧과", "비교하세요."] : ["있습니다.", "사용량은"]) expect(await renderedWordLineCount(intro, word)).toBe(1);
    const description = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Claude Fable 5", exact: true }) }).locator("p.mt-4");
    // The card text is the per-model criteria line (#3556); in Korean it names
    // image input support only (#3716).
    expect(await renderedWordLineCount(description, "이미지")).toBe(1);
    if (width === 320) {
      await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
      await intro.evaluate(node => { node.textContent += ` https://example.com/${"long".repeat(30)}`; });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
