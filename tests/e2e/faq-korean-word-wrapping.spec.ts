import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";
import { renderedWordLineCount } from "./support/text-wrapping";

for (const theme of ["light", "dark"] as const) {
  test(`${theme} keeps Korean FAQ words intact at 320px and enlarged text`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await prepareGuestPage(page, "ko");
    await setDeterministicTheme(page, theme);
    await page.goto("/ko/faq");
    const titles = page.locator("article h2");
    const used = titles.filter({ hasText: "모델을 여러 개 쓰면" });
    const question = titles.filter({ hasText: "가입 없이 무엇을" });
    const body = page.locator("article").first().locator("p").first();
    for (const scale of [100, 200]) {
      await page.addStyleTag({ content: `html { font-size: ${scale}%; }` });
      expect(await renderedWordLineCount(used, "쓰면")).toBe(1);
      expect(await renderedWordLineCount(question, "있나요?")).toBe(1);
      expect(await renderedWordLineCount(body, "사용하세요.")).toBe(1);
      await expect(body).toHaveCSS("word-break", "keep-all");
      await expectNoHorizontalOverflow(page);
    }
    await body.evaluate(node => { node.textContent += " " + "LongEnglishIdentifier".repeat(20); });
    await expect(body).toHaveCSS("overflow-wrap", "anywhere");
    await expectNoHorizontalOverflow(page);
  });
}
