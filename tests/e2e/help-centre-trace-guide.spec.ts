import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test("English support guidance explains the trace location, copy action and no-ID fallback", async ({ page }) => {
  test.setTimeout(90_000);
  await prepareGuestPage(page, "en");
  await page.goto("/en/support/help-centre");
  const failedAnswer = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "When an answer does not arrive", exact: true }) });
  await expect(failedAnswer).toContainText("beneath the failed answer’s error message", { timeout: 30_000 });
  await expect(failedAnswer).toContainText("select and copy its value");
  const contact = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Contact support", exact: true }) });
  await expect(contact).toContainText("Copy diagnostic details");
  await expect(contact).toContainText("If no ID is shown, you can still contact support");
  await expect(contact).toContainText("exact error message, browser and steps");
  await contact.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
});
