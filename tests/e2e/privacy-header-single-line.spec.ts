import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { setDeterministicTheme } from "./support/chat-state-fixtures";

for (const theme of ["light", "dark"] as const) {
  test(`privacy header keeps desktop action labels together in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await prepareGuestPage(page, "en");
    await setDeterministicTheme(page, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/privacy?lang=en");
    const header = page.getByTestId("launch-marketing-header");
    const cta = header.getByTestId("marketing-header-app-cta");
    await expect(cta).toHaveAttribute("data-session-state", "unauthenticated", { timeout: 30_000 });
    const links = [header.getByRole("link", { name: "Explore models", exact: true }), header.getByRole("link", { name: /^Sign in$/i }), cta];
    for (const width of [1440, 1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      for (const link of links) {
        await expect(link).toBeVisible();
        const lines = await link.evaluate(element => {
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const tops = new Set<number>(); let node: Node | null;
          while ((node = walker.nextNode())) for (let index = 0; index < (node.textContent?.length ?? 0); index++) {
            if (!node.textContent![index].trim()) continue;
            const range = document.createRange(); range.setStart(node, index); range.setEnd(node, index + 1); tops.add(Math.round(range.getBoundingClientRect().top));
          }
          return tops.size;
        });
        expect(lines, `${width}px ${await link.textContent()}`).toBe(1);
      }
      await expectNoHorizontalOverflow(page);
    }
    await page.setViewportSize({ width: 320, height: 900 });
    const menu = header.getByTestId("marketing-menu-button");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveAttribute("aria-expanded", "false");
    await expectNoHorizontalOverflow(page);
  });
}
