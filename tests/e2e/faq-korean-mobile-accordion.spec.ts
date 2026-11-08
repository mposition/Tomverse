import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";
import { infoPages } from "../../components/marketing/marketingInfoContent";

for (const theme of ["light", "dark"] as const) {
  test(`mobile FAQ supports keyboard expansion and compact browsing in ${theme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.emulateMedia({ colorScheme: theme });
    await prepareGuestPage(page, "ko");
    await page.goto("/ko/faq");
    await page.addStyleTag({ content: "nextjs-portal { display:none!important; }" });
    const articles = page.getByRole("article");
    await expect(articles).toHaveCount(infoPages.faq.ko.sections.length, { timeout: 30_000 });
    const first = articles.first();
    const toggle = first.getByRole("button");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(first.locator("p")).toBeHidden();
    const collapsedHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(first.locator("p")).toBeVisible();
    await expect(toggle).toBeFocused();
    const target = await toggle.getAttribute("aria-controls");
    expect(await first.locator("p").evaluate((node, id) => node.parentElement?.id === id, target)).toBe(true);
    await page.keyboard.press("Space");
    await expect(first.locator("p")).toBeHidden();
    for (const article of await articles.all()) {
      const button = article.getByRole("button");
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await button.click();
      await expect(article.locator("p")).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(collapsedHeight + 500);
    await page.addStyleTag({ content: "html { font-size: 200%; }" });
    await expectNoHorizontalOverflow(page);
  });
}

test("desktop FAQ keeps every answer expanded without redundant toggle controls", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await prepareGuestPage(page, "ko");
  await page.goto("/ko/faq");
  const articles = page.getByRole("article");
  await expect(articles).toHaveCount(infoPages.faq.ko.sections.length);
  for (const article of await articles.all()) {
    await expect(article.locator("p")).toBeVisible();
    await expect(article.getByRole("button")).toHaveCount(0);
  }
});
