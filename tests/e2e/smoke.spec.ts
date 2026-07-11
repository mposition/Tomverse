import { expect, test } from "@playwright/test";

test("home renders one application shell", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("main")).toBeVisible();
  await expect(page.locator("main")).toHaveCount(1);
});
