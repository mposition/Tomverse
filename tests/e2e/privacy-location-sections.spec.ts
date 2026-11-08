import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test("English location notice separates controls, permissions and retention", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await prepareGuestPage(page, "en");
  await page.setViewportSize({ width: testInfo.project.name.startsWith("mobile") ? 320 : 1440, height: 900 });
  await page.goto("/privacy?lang=en");
  const notice = page.getByTestId("privacy-location-sections");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice.getByRole("heading", { level: 3 })).toHaveText(["Use and turn off", "Permission requests", "Sending and retention"]);
  await expect(notice.getByRole("listitem")).toHaveCount(4);
  await expect(notice).toContainText("we read a fresh approximate position when you send a message");
  await expect(notice).toContainText("it receives no device position");
  await expect(notice).toContainText("We do not track your location in the background");
  await expect(notice).toContainText("resets on reload or account change");
  await expect(notice).toContainText("normal chat retention, export and sharing settings");
  await notice.scrollIntoViewIfNeeded();
  await expectNoHorizontalOverflow(page);
});
