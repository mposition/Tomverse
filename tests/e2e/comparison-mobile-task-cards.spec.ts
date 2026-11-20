import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

// The ChatGPT vs Claude checklist on the V2 guide template is one set of rows: a four-column
// table on wide screens that stacks into labelled rows on a small phone.
test("small-screen comparison rows preserve every model criterion and check", async ({ page }, info) => {
  const mobile = info.project.name.includes("mobile");
  await page.setViewportSize({ width: mobile ? 320 : 1440, height: 900 });
  await prepareGuestPage(page, "en");
  await page.goto("/chatgpt-vs-claude");
  const table = page.getByTestId("comparison-task-table");
  await expect(table).toBeVisible();
  if (!mobile) {
    await expect(table.getByRole("columnheader")).toHaveCount(4);
    return;
  }
  // The header row folds away; each cell carries its own column label instead.
  await expect(table.getByRole("columnheader")).toHaveCount(0);
  const rows = table.locator(".mrow").filter({ has: page.locator("b") });
  expect(await rows.count()).toBeGreaterThan(0);
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    await expect(row.getByRole("rowheader")).toBeVisible();
    const cells = row.getByRole("cell");
    await expect(cells).toHaveCount(3);
    for (const cell of await cells.all()) {
      await expect(cell).toBeVisible();
      const label = await cell.getAttribute("data-h");
      expect(label).toBeTruthy();
      expect(await cell.evaluate(node => getComputedStyle(node, "::before").content)).toBe(`"${label}"`);
    }
  }
  await rows.last().scrollIntoViewIfNeeded();
  await expect(rows.last()).toBeInViewport();
  await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
  expect(await table.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
