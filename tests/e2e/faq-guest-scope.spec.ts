import { expect, test } from "@playwright/test";
import { APP_DEFAULTS } from "@/lib/appDefaults";
import { expectNoHorizontalOverflow, prepareGuestPage } from "./support/app-fixtures";

test("guest FAQ distinguishes trials, allowances, local files and account-only features", async ({ page }) => {
  await prepareGuestPage(page, "en");
  await page.goto("/en/faq");
  const answer = page.locator("article").filter({ has: page.getByRole("heading", { name: "What can I try without an account?", exact: true }) });
  await expect(answer).toContainText(`compare up to ${APP_DEFAULTS.maxGuestSelectedModels} eligible guest models`);
  await expect(answer).toContainText("Chat when guest access is offered on the start screen");
  await expect(answer).toContainText(`${APP_DEFAULTS.maxGuestMessages} credits per UTC day and ${APP_DEFAULTS.maxGuestMonthlyCredits} per UTC month`);
  await expect(answer).toContainText("Sign in to save conversations to your account or create share links.");
  await expect(answer).toContainText("1 supported local file per message, up to 5 MB");
  await expect(answer).toContainText("uploads are temporary");
  await expect(answer).toContainText("Sign in to connect Google Drive");
  await expectNoHorizontalOverflow(page);
});
