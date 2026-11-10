import { expect, test } from "@playwright/test";
import { prepareGuestPage } from "./support/app-fixtures";

test("model and credit help names its pricing destination", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/en/support/help-centre");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "Models and credits", exact: true }) });
  const link = card.getByRole("link", { name: "Compare plans and credits", exact: true });
  await expect(link).toHaveAttribute("href", "/en/pricing");
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/en\/pricing$/);
  await expect(page.getByRole("main")).toBeVisible();
});
