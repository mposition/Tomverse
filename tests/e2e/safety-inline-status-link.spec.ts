import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test("safety service-status guidance is an underlined keyboard link", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/en/safety");
  const card = page.locator("article").filter({ has: page.getByRole("heading", { name: "AI limitations and service status", exact: true }) });
  const link = card.getByRole("link", { name: "service-status page", exact: true });
  await expect(link).toHaveAttribute("href", "/status?lang=en");
  expect(await link.evaluate((node) => getComputedStyle(node).textDecorationLine)).toContain("underline");
  await expect(card).toContainText("see the service-status page for current availability.");
  await expectNoHorizontalOverflow(page);
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/status\?lang=en$/);
  await expect(page.locator("main")).toBeVisible();
});
