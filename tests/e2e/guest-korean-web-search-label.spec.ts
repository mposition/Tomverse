import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme, suppressTransientUi } from "./support/chat-state-fixtures";

test.use({ hasTouch: true });
test.setTimeout(90_000);
for (const appearance of ["classic", "studio"] as const) for (const theme of ["light", "dark"] as const) {
  test(`Korean guest web status stays readable in ${appearance} ${theme}`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    await prepareGuestPage(page, "ko", "classic", appearance);
    await setDeterministicTheme(page, theme);
    await suppressTransientUi(page);
    await page.context().addCookies([{ name: "__tomverse_e2e_chat_workspace", value: "1", url: baseURL! }]);
    await page.goto("/chat?lang=ko");
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
    const chip = page.getByTestId("web-search-mode-chip");
    const label = chip.getByText("웹 검색", { exact: true });
    await expect(label).toBeVisible({ timeout: 60_000 });
    for (const fontSize of [16, 32]) {
      await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, fontSize);
      expect(await label.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      const textarea = page.getByTestId("chat-textarea");
      expect((await textarea.boundingBox())!.height).toBeGreaterThanOrEqual(44 * fontSize / 16);
      expect(await chip.evaluate(node => node.getBoundingClientRect().top >= document.querySelector('[data-testid="chat-textarea"]')!.getBoundingClientRect().bottom)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
    await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
    await chip.getByRole("button").click();
    await expect(chip).toBeHidden();
    await page.getByTestId("composer-tools-button").click();
    await expect(page.getByTestId("tools-web-search-row")).toHaveAttribute("aria-checked", "false");
  });
}
