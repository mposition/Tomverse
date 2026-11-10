import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("small-screen comparison cards preserve every model criterion and check", async ({ page }, info) => {
  const mobile = info.project.name.includes("mobile");
  await page.setViewportSize({ width: mobile ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/chatgpt-vs-claude");
  const table = page.getByTestId("comparison-task-table");
  const cards = page.getByTestId("comparison-task-cards");
  if (!mobile) {
    await expect(table).toBeVisible();
    await expect(cards).toBeHidden();
    await expect(table.getByRole("columnheader")).toHaveCount(4);
    return;
  }
  await expect(table).toBeHidden();
  await expect(cards).toBeVisible();
  const rows = table.locator("tbody tr");
  const articles = cards.getByRole("article");
  await expect(articles).toHaveCount(await rows.count());
  for (let index = 0; index < await rows.count(); index++) {
    const values = await rows.nth(index).locator("th,td").allTextContents();
    const card = articles.nth(index);
    await expect(card.getByRole("heading")).toHaveText(values[0]);
    await expect(card.locator("dd")).toHaveText(values.slice(1));
    await expect(card.locator("dt")).toHaveCount(3);
  }
  await articles.last().scrollIntoViewIfNeeded();
  await expect(articles.last()).toBeInViewport();
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  expect(await cards.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
